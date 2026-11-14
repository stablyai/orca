import { useCallback, useMemo } from 'react'
import { Platform } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { File as FsFile, type Directory, type FileHandle } from 'expo-file-system'
import { useFocusEffect, useNavigation } from 'expo-router'
import { saveImageToPhotos, shareImage } from '../../../modules/orca-mobile-web-shell/src/index'
import {
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../../../src/shared/clipboard-image'
import { isKnownRasterImageMimeType } from '../../../../src/shared/file-preview/raster-image-preview-limits'
import {
  imageParamsSchema,
  type BridgeImageRunParams
} from '../../mobile-web-shell/bridge/bridge-image-verbs'
import { BridgeNativeVerbRefusedError } from '../../mobile-web-shell/bridge-host-errors'
import { decodeCanonicalBase64Bytes } from '../../transport/encryption/base64-byte-codec'
import { mobileFileExtensionForMime } from '../media-picking/mobile-picked-file-name'
import { freshCacheFolder } from '../media-picking/native-media-device'

type Staged = { folder: Directory; file: FsFile; handle: FileHandle; byteLength: number }

type Ready = { file: FsFile; mime: string }

function tooLarge(): BridgeNativeVerbRefusedError {
  return new BridgeNativeVerbRefusedError('native_media_too_large', CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
}

// Photos and share targets pick the format from the extension, so the file is named after its type.
function namedForMime(file: FsFile, folder: Directory, mime: string): FsFile {
  const named = new FsFile(folder, `image.${mobileFileExtensionForMime(mime)}`)
  // A download can already carry the name; moving a file onto itself throws on iOS.
  if (named.uri !== file.uri) {
    file.moveSync(named)
  }
  return named
}

async function download(url: string): Promise<Ready> {
  const folder = freshCacheFolder('orca-image-actions')
  const file = await FsFile.downloadFileAsync(url, folder)
  const raster = isKnownRasterImageMimeType(file.type)
  if (!raster || file.size > CLIPBOARD_IMAGE_MAX_SOURCE_BYTES) {
    folder.delete()
    throw raster ? tooLarge() : new Error('the link is not an image the phone can save')
  }
  return { file: namedForMime(file, folder, file.type), mime: file.type }
}

function sharedUri(file: FsFile): string {
  return Platform.OS === 'android' ? file.contentUri : file.uri
}

// Serves native.image.act for one page session: staged chunks, then one copy, save or share on the user's tap.
function createNativeImageActions(isFocused: () => boolean) {
  let staged: Staged | null = null
  let disposals = 0

  const dropStaged = () => {
    staged?.handle.close()
    staged = null
  }

  // A covered or replaced page must not raise a share sheet or permission prompt over another screen, even after a slow download.
  const assertLive = (generation: number) => {
    if (generation !== disposals || !isFocused()) {
      throw new Error('the image page is no longer shown')
    }
  }

  const stage = (offset: number, base64: string) => {
    const bytes = decodeCanonicalBase64Bytes(base64)
    if (!bytes) {
      throw new BridgeNativeVerbRefusedError('native_verb_params', 'the image chunk is not base64')
    }
    if (offset === 0) {
      dropStaged()
      const folder = freshCacheFolder('orca-image-actions')
      const file = new FsFile(folder, 'image.bin')
      file.create({ overwrite: true })
      staged = { folder, file, handle: file.open(), byteLength: 0 }
    }
    if (!staged || staged.byteLength !== offset) {
      throw new BridgeNativeVerbRefusedError(
        'native_media_range',
        'the image chunk does not continue the staged image'
      )
    }
    if (offset + bytes.byteLength > CLIPBOARD_IMAGE_MAX_SOURCE_BYTES) {
      dropStaged()
      throw tooLarge()
    }
    staged.handle.writeBytesSync(bytes)
    staged.byteLength += bytes.byteLength
  }

  const takeStaged = (mime: string, byteLength: number): Ready => {
    const current = staged
    dropStaged()
    if (!current || current.byteLength !== byteLength) {
      throw new BridgeNativeVerbRefusedError(
        'native_media_range',
        'the staged image is incomplete or was replaced'
      )
    }
    return { file: namedForMime(current.file, current.folder, mime), mime }
  }

  const run = async ({ operation, source }: BridgeImageRunParams) => {
    const generation = disposals
    assertLive(generation)
    const { file, mime } =
      source.kind === 'staged'
        ? takeStaged(source.mime, source.byteLength)
        : await download(source.url)
    assertLive(generation)
    if (operation === 'copy') {
      await Clipboard.setImageAsync(await file.base64())
    } else if (operation === 'save') {
      await saveImageToPhotos(sharedUri(file), mime)
    } else {
      await shareImage(sharedUri(file), mime)
    }
  }

  return {
    serve: async (params: unknown): Promise<Record<string, never>> => {
      const request = imageParamsSchema.parse(params)
      if (request.action === 'stage') {
        stage(request.offset, request.base64)
      } else {
        await run(request)
      }
      return {}
    },
    dispose: () => {
      disposals += 1
      dropStaged()
    }
  }
}

export function useNativeImageActions(
  sessionId: string | null
): (params: unknown) => Promise<unknown> {
  const navigation = useNavigation()
  const actions = useMemo(
    () => createNativeImageActions(navigation.isFocused),
    // A new page session is a new document; it must not inherit a half-staged image.
    [navigation, sessionId]
  )
  useFocusEffect(useCallback(() => () => actions.dispose(), [actions]))
  return actions.serve
}
