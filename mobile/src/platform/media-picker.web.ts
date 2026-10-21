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

/**
 * Web sibling: the page has no photo library and no Files app, so the shell picks for it and hands
 * back a handle.
 *
 * A handle rather than the bytes because a picked image reaches 18 MiB raw, which is over twice the
 * bridge's reply ceiling before base64 has touched it. So one pick is `pick`, then `read` in order
 * to `eof`, then `release` for every handle it was handed, including the ones its caller never
 * took — the shell holds eight staged files at a time and an abandoned pick otherwise waits out the
 * five-minute TTL.
 *
 * Every refusal rejects. A shell that refused the pick, a handle that expired mid-read and a route
 * that was never granted the verb all surface as the `NativeVerbError` the bridge built, with the
 * reason on it; none of them is folded into the empty answer that means "the user cancelled",
 * because a screen showing nothing and a screen showing why are different screens.
 *
 * The pasteboard is not here. `clipboard.web.ts` owns it on both platforms, and on the web it
 * reaches the same `native.media.pick` with `source: 'clipboard'`.
 */

/** No preview URI on the page: the shell's staged file is a path in the app's cache that this
 *  document cannot load, and the composer already falls back to an inline data URI. */
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
      // Released before the yield, not after: the caller may take one image and walk away, and the
      // shell counts what it is still holding against every later pick.
      unread.shift()
      await releaseStagedMedia(verbs, item.handle)
      yield pickedImage(base64)
    }
  } finally {
    // The item whose read threw, and everything the caller never asked for.
    await releaseAllStagedMedia(verbs, unread)
  }
}

/** The shell refuses a file over what it stages; that refusal reads as the size error. */
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
      // An older shell cannot name the file; the page names it from its type instead.
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
