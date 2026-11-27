import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import {
  ImageLibraryPermissionError,
  MOBILE_PICKED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  type MobilePickedFileSource,
  type PickedMobileFile
} from '../../platform/media-picking/media-picker-contract'
import { mobilePickedFileFallbackName } from '../../platform/media-picking/mobile-picked-file-name'
import {
  defaultMobileImageFileFactory,
  type MobileImageFileFactory
} from './mobile-image-source-picker'
import { AGENT_SESSION_ATTACHMENT_CHUNK_BYTES } from '../../../../src/shared/agent-session/agent-session-attachments'

const UNKNOWN_FILE_MIME = 'application/octet-stream'
const FILE_READ_CHUNK_BYTES = AGENT_SESSION_ATTACHMENT_CHUNK_BYTES

type MobileFilePickerDeps = {
  readonly launch?: typeof DocumentPicker.getDocumentAsync
  readonly launchVideos?: () => Promise<PickedFileAssets>
  readonly createFile?: MobileImageFileFactory
}

type PickedFileAssets =
  | { readonly canceled: true }
  | {
      readonly canceled: false
      readonly assets: readonly {
        readonly uri: string
        readonly name: string
        readonly size?: number | null
        readonly mimeType?: string | null
      }[]
    }

// The Files app cannot reach the photo library on iOS, so recorded videos come from the library picker.
async function launchLibraryVideos(): Promise<PickedFileAssets> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) {
    throw new ImageLibraryPermissionError()
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    allowsMultipleSelection: true,
    selectionLimit: 0,
    // Compatible would transcode every video before it could stream.
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current
  })
  if (result.canceled) {
    return { canceled: true }
  }
  return {
    canceled: false,
    assets: result.assets.map((asset, index) => ({
      uri: asset.uri,
      name:
        asset.fileName?.trim() ||
        mobilePickedFileFallbackName(asset.mimeType ?? 'video/mp4', index + 1),
      size: asset.fileSize,
      mimeType: asset.mimeType
    }))
  }
}

// An oversized file stops the pick; files already yielded remain with the caller.
export async function* pickMobileFiles(
  from: MobilePickedFileSource = 'files',
  deps?: MobileFilePickerDeps
): AsyncGenerator<PickedMobileFile> {
  const launch = deps?.launch ?? DocumentPicker.getDocumentAsync
  const createFile = deps?.createFile ?? defaultMobileImageFileFactory
  const result =
    from === 'videos'
      ? await (deps?.launchVideos ?? launchLibraryVideos)()
      : await launch({ type: '*/*', multiple: true, copyToCacheDirectory: true })
  if (result.canceled) {
    return
  }
  for (const asset of result.assets) {
    if (!asset.uri) {
      continue
    }
    const name = asset.name.trim() || 'attachment'
    const file = createFile(asset.uri)
    const byteLength = file.size
    if (
      (typeof asset.size === 'number' && asset.size > MOBILE_PICKED_FILE_MAX_BYTES) ||
      !Number.isFinite(byteLength) ||
      byteLength > MOBILE_PICKED_FILE_MAX_BYTES
    ) {
      throw new MobileFileTooLargeError(name)
    }
    yield {
      name,
      mime: asset.mimeType ?? UNKNOWN_FILE_MIME,
      byteLength,
      readBytes: () => readFileBytes(file, byteLength)
    }
  }
}

// A file that changes size mid-read would commit something other than what was weighed, so refuse it.
async function* readFileBytes(
  file: ReturnType<MobileImageFileFactory>,
  byteLength: number
): AsyncGenerator<Uint8Array> {
  const handle = file.open()
  try {
    let read = 0
    for (;;) {
      const bytes = handle.readBytesSync(FILE_READ_CHUNK_BYTES)
      if (bytes.byteLength === 0) {
        break
      }
      read += bytes.byteLength
      if (read > byteLength) {
        throw new Error('The file grew while it was being attached')
      }
      yield bytes
    }
    if (read !== byteLength) {
      throw new Error('The file shrank while it was being attached')
    }
  } finally {
    handle.close()
  }
}
