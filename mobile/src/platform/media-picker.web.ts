import { useMemo } from 'react'
import type { BridgeMediaItem } from '../mobile-web-shell/bridge/bridge-media-verbs'
import {
  readStagedMediaItem,
  releaseAllStagedMedia,
  releaseStagedMedia
} from '../mobile-web-shell/bridge/staged-media-bytes'
import {
  NativeVerbError,
  useNativeVerbs,
  type NativeVerbs
} from '../mobile-web-shell/bridge/use-native-verbs'
import {
  MobileFileTooLargeError,
  type MediaPicker,
  type PickedMobileFile,
  type PickedMobileImage
} from './media-picker-contract'
import { mobilePickedFileFallbackName } from './mobile-picked-file-name'

// Read staged handles in chunks because images exceed reply caps; release every handle, including unused extras, before the eight-item registry fills.
// Refusals reject; only user cancellation returns an empty selection.

// The page cannot load a native cache URI; the composer falls back to an inline data URI.
function pickedImage(base64: string): PickedMobileImage {
  return { base64 }
}

async function* readPicked(
  verbs: NativeVerbs,
  items: readonly BridgeMediaItem[]
): AsyncGenerator<PickedMobileImage> {
  const unread = [...items]
  try {
    while (unread.length > 0) {
      const item = unread[0]!
      const base64 = await readStagedMediaItem(verbs, item)
      // Release before yielding because callers may stop after one image and strand scarce handles.
      unread.shift()
      await releaseStagedMedia(verbs, item.handle)
      yield pickedImage(base64)
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
      // Older shells lack nameMedia; derive a filename from MIME instead.
      const name =
        (verbs.canNameMedia ? await verbs.nameMedia(item.handle) : null) ??
        mobilePickedFileFallbackName(item.mime, index)
      const base64 = await readStagedMediaItem(verbs, item)
      unread.shift()
      await releaseStagedMedia(verbs, item.handle)
      yield { name, mime: item.mime, byteLength: item.byteLength, base64 }
    }
  } finally {
    await releaseAllStagedMedia(verbs, unread)
  }
}

export function useMediaPicker(): MediaPicker {
  const verbs = useNativeVerbs()

  return useMemo<MediaPicker>(
    () => ({
      pickImage: async (source) => {
        for await (const image of readPicked(verbs, await verbs.pickMedia(source, false))) {
          return image
        }
        return null
      },
      pickImages: (source) => ({
        [Symbol.asyncIterator]: async function* () {
          yield* readPicked(verbs, await verbs.pickMedia(source, true))
        }
      }),
      pickFiles: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield* readPickedFiles(verbs, await pickFileItems(verbs))
        }
      })
    }),
    [verbs]
  )
}
