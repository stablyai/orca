import { useMemo } from 'react'
import type { BridgeMediaItem } from '../../mobile-web-shell/bridge/native-capabilities/bridge-media-verbs'
import {
  readStagedMediaItem,
  releaseAllStagedMedia,
  releaseStagedMedia
} from '../../mobile-web-shell/bridge/native-capabilities/staged-media-bytes'
import {
  NativeVerbError,
  useNativeVerbs,
  type NativeVerbs
} from '../../mobile-web-shell/bridge/native-capabilities/use-native-verbs'
import {
  MobileFileTooLargeError,
  MobilePickedFileGoneError,
  MobilePickedFilesBusyError,
  type MediaPicker,
  type MobileImageSource,
  type StagedMobileFile,
  type PickedMobileFile,
  type PickedMobileImage
} from './media-picker-contract'
import { isPickedImageMime, mobilePickedFileFallbackName } from './mobile-picked-file-name'

// Read staged handles in chunks because images exceed reply caps; release every handle, including unused extras, before the eight-item registry fills.
// Refusals reject; only user cancellation returns an empty selection.

// The page cannot load a native cache URI; the composer falls back to an inline data URI.
function pickedImage(
  base64: string,
  fileName: string | undefined,
  mime: string
): PickedMobileImage {
  return { base64, fileName, mime }
}

// Older shells lack nameMedia; derive a filename from MIME instead.
async function pickedFileName(
  verbs: NativeVerbs,
  item: BridgeMediaItem,
  index: number
): Promise<string> {
  return (
    (verbs.canNameMedia ? await verbs.nameMedia(item.handle) : null) ??
    mobilePickedFileFallbackName(item.mime, index)
  )
}

async function* readPicked(
  verbs: NativeVerbs,
  items: readonly BridgeMediaItem[],
  source: MobileImageSource
): AsyncGenerator<PickedMobileImage> {
  const unread = [...items]
  try {
    let index = 0
    while (unread.length > 0) {
      const item = unread[0]!
      index += 1
      const fileName =
        source === 'files' && !isPickedImageMime(item.mime)
          ? await pickedFileName(verbs, item, index)
          : undefined
      const base64 = await readStagedMediaItem(verbs, item)
      // Release before yielding because callers may stop after one image and strand scarce handles.
      unread.shift()
      await releaseStagedMedia(verbs, item.handle)
      yield pickedImage(base64, fileName, item.mime)
    }
  } finally {
    await releaseAllStagedMedia(verbs, unread)
  }
}

async function pickFileItems(verbs: NativeVerbs): Promise<readonly BridgeMediaItem[]> {
  try {
    return await verbs.pickMedia('files', true)
  } catch (error) {
    throw error instanceof NativeVerbError && error.reason === 'native_media_too_large'
      ? new MobileFileTooLargeError(null)
      : error
  }
}

async function* readPickedFiles(
  verbs: NativeVerbs,
  items: readonly BridgeMediaItem[]
): AsyncGenerator<PickedMobileFile> {
  const unread = [...items]
  try {
    let index = 0
    while (unread.length > 0) {
      const item = unread[0]!
      index += 1
      const name = await pickedFileName(verbs, item, index)
      const base64 = await readStagedMediaItem(verbs, item)
      unread.shift()
      await releaseStagedMedia(verbs, item.handle)
      yield { name, mime: item.mime, byteLength: item.byteLength, base64 }
    }
  } finally {
    await releaseAllStagedMedia(verbs, unread)
  }
}

function goneWhenUnknown(error: unknown): never {
  throw error instanceof NativeVerbError && error.reason === 'native_media_handle_unknown'
    ? new MobilePickedFileGoneError()
    : error
}

// Names are read before returning so the caller can show every row at once; any failure frees every handle.
async function stagedFiles(verbs: NativeVerbs): Promise<readonly StagedMobileFile[]> {
  const items = await pickFileItems(verbs).catch((error: unknown) => {
    throw error instanceof NativeVerbError && error.reason === 'native_media_handle_cap'
      ? new MobilePickedFilesBusyError()
      : error
  })
  try {
    const files: StagedMobileFile[] = []
    for (const [index, item] of items.entries()) {
      files.push({
        name: await pickedFileName(verbs, item, index + 1),
        byteLength: item.byteLength,
        read: (offset, length) =>
          verbs.readMedia(item.handle, offset, length).catch(goneWhenUnknown),
        // Any read refreshes the shell's idle clock; one byte is the cheapest.
        keepAlive: async () => {
          await verbs.readMedia(item.handle, 0, 1).catch(goneWhenUnknown)
        },
        release: () => releaseStagedMedia(verbs, item.handle)
      })
    }
    return files
  } catch (error) {
    await releaseAllStagedMedia(verbs, items)
    throw error
  }
}

export function useMediaPicker(): MediaPicker {
  const verbs = useNativeVerbs()

  return useMemo<MediaPicker>(
    () => ({
      pickImage: async (source) => {
        for await (const image of readPicked(verbs, await verbs.pickMedia(source, false), source)) {
          return image
        }
        return null
      },
      pickImages: (source) => ({
        [Symbol.asyncIterator]: async function* () {
          yield* readPicked(verbs, await verbs.pickMedia(source, true), source)
        }
      }),
      pickFiles: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield* readPickedFiles(verbs, await pickFileItems(verbs))
        }
      }),
      ...(verbs.canPickMedia ? { pickStagedFiles: () => stagedFiles(verbs) } : {})
    }),
    [verbs]
  )
}
