import { useMemo } from 'react'
import type { BridgeMediaItem } from '../mobile-web-shell/bridge/bridge-media-verbs'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../../src/shared/agent-session/agent-session-attachments'
import {
  readStagedMediaChunks,
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
  MOBILE_PICKED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  type MediaPicker,
  type MobileImageSource,
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

// Shells with the large-file verb take one file up to 200 MB; older ones stage several files up to their own ceiling and refuse the rest.
async function pickFileItems(verbs: NativeVerbs): Promise<readonly BridgeMediaItem[]> {
  const large = verbs.canPickLargeFile
  try {
    return large ? await verbs.pickLargeFile() : await verbs.pickMedia('files', true)
  } catch (error) {
    if (error instanceof NativeVerbError && error.reason === 'native_media_too_large') {
      throw large
        ? new MobileFileTooLargeError(null, AGENT_SESSION_ATTACHMENT_MAX_BYTES, 'limit')
        : new MobileFileTooLargeError(null, MOBILE_PICKED_FILE_MAX_BYTES, 'update-app')
    }
    throw error
  }
}

// A file's bytes are read only when its chunks are iterated, so nothing but one chunk is ever held.
// Handle release: chunks() releases its handle when its iteration ends or is abandoned; this generator releases the previous item's handle (read or not) before advancing, and every remaining handle when the consumer stops, throws or finishes.
async function* readPickedFiles(
  verbs: NativeVerbs,
  items: readonly BridgeMediaItem[]
): AsyncGenerator<PickedMobileFile> {
  const held = new Set(items)
  const release = async (item: BridgeMediaItem): Promise<void> => {
    if (held.delete(item)) {
      await releaseStagedMedia(verbs, item.handle)
    }
  }
  async function* streamed(item: BridgeMediaItem): AsyncGenerator<string> {
    try {
      yield* readStagedMediaChunks(verbs, item)
    } finally {
      await release(item)
    }
  }
  try {
    let index = 0
    for (const item of items) {
      index += 1
      const name = await pickedFileName(verbs, item, index)
      yield { name, mime: item.mime, byteLength: item.byteLength, chunks: () => streamed(item) }
      await release(item)
    }
  } finally {
    for (const item of held) {
      await release(item)
    }
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
      })
    }),
    [verbs]
  )
}
