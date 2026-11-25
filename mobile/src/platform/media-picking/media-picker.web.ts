import { useMemo } from 'react'
import type { BridgeMediaItem } from '../../mobile-web-shell/bridge/native-capabilities/bridge-media-verbs'
import {
  readStagedMediaItem,
  streamStagedMediaBase64,
  releaseAllStagedMedia,
  releaseStagedMedia
} from '../../mobile-web-shell/bridge/native-capabilities/staged-media-bytes'
import {
  NativeVerbError,
  useNativeVerbs,
  type NativeVerbs
} from '../../mobile-web-shell/bridge/native-capabilities/use-native-verbs'
import {
  MOBILE_STREAMED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  type MediaPicker,
  type MobileGalleryPick,
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

async function pickFileItems(verbs: NativeVerbs): Promise<readonly BridgeMediaItem[]> {
  try {
    return await verbs.pickMedia('files', true)
  } catch (error) {
    throw error instanceof NativeVerbError && error.reason === 'native_media_too_large'
      ? new MobileFileTooLargeError(null, MOBILE_STREAMED_FILE_MAX_BYTES)
      : error
  }
}

// Chunks are read lazily and the handle stays live until the upload settles; unread handles are released when iteration ends.
async function* readPickedFiles(
  verbs: NativeVerbs,
  items: readonly BridgeMediaItem[]
): AsyncGenerator<PickedMobileFile> {
  const unreleased = new Map(items.map((item) => [item.handle, item]))
  const release = async (handle: string): Promise<void> => {
    if (unreleased.delete(handle)) {
      await releaseStagedMedia(verbs, handle)
    }
  }
  try {
    let index = 0
    for (const item of items) {
      index += 1
      const name = await pickedFileName(verbs, item, index)
      yield {
        name,
        mime: item.mime,
        byteLength: item.byteLength,
        chunks: () => streamStagedMediaBase64(verbs, item),
        dispose: () => void release(item.handle)
      }
      await release(item.handle)
    }
  } finally {
    await releaseAllStagedMedia(verbs, [...unreleased.values()])
  }
}

// The shell's refusal names the ceiling it enforced: an image stages whole under a smaller one than a streamed video.
const STAGING_CEILING_RE = /over the (\d+) this shell stages/

function refuseTooLarge(error: unknown): unknown {
  if (!(error instanceof NativeVerbError) || error.reason !== 'native_media_too_large') {
    return error
  }
  const ceiling = Number(STAGING_CEILING_RE.exec(error.message)?.[1])
  return new MobileFileTooLargeError(
    null,
    Number.isFinite(ceiling) && ceiling > 0 ? ceiling : MOBILE_STREAMED_FILE_MAX_BYTES
  )
}

// A gallery selection holds its video handles until each upload ends, so every handle is released by its file's dispose or by a failure here.
async function pickGallerySelection(verbs: NativeVerbs): Promise<MobileGalleryPick> {
  const items = await verbs.pickMedia('gallery', true).catch((error: unknown) => {
    throw refuseTooLarge(error)
  })
  const isVideo = (item: BridgeMediaItem): boolean => item.mime.startsWith('video/')
  const videoItems = items.filter(isVideo)
  const unreleased = new Map(videoItems.map((item) => [item.handle, item]))
  try {
    const images: PickedMobileImage[] = []
    for await (const image of readPicked(
      verbs,
      items.filter((item) => !isVideo(item)),
      'library'
    )) {
      images.push(image)
    }
    const videos: PickedMobileFile[] = []
    let index = 0
    for (const item of videoItems) {
      index += 1
      videos.push({
        name: await pickedFileName(verbs, item, index),
        mime: item.mime,
        byteLength: item.byteLength,
        chunks: () => streamStagedMediaBase64(verbs, item),
        dispose: () => {
          if (unreleased.delete(item.handle)) {
            void releaseStagedMedia(verbs, item.handle)
          }
        }
      })
    }
    return { images, videos }
  } catch (error) {
    await releaseAllStagedMedia(verbs, [...unreleased.values()])
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
      pickGallery: () => pickGallerySelection(verbs),
      pickFiles: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield* readPickedFiles(verbs, await pickFileItems(verbs))
        }
      })
    }),
    [verbs]
  )
}
