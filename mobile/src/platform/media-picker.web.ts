import { useMemo } from 'react'
import type { BridgeMediaItem } from '../mobile-web-shell/bridge/bridge-media-verbs'
import {
  readStagedMediaItem,
  releaseAllStagedMedia,
  releaseStagedMedia
} from '../mobile-web-shell/bridge/staged-media-bytes'
import { useNativeVerbs, type NativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { MediaPicker, PickedMobileImage } from './media-picker-contract'

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
      })
    }),
    [verbs]
  )
}
