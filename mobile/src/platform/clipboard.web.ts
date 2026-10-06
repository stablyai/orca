import { useMemo } from 'react'
import {
  readStagedMediaItem,
  releaseAllStagedMedia
} from '../mobile-web-shell/bridge/staged-media-bytes'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { ClipboardImage, ClipboardReader, ClipboardWriter } from './clipboard'

/**
 * Web sibling: the page has no clipboard of its own worth using, so the shell writes for it.
 *
 * `expo-clipboard` resolves to `navigator.clipboard` on the web, which needs a secure context —
 * and the iOS shell serves the page from a custom scheme while Android serves `https`, so that
 * path would work on one platform and not the other with no way to tell from here. The verb goes
 * to the shell instead, where the pasteboard is the device's.
 *
 * A route that did not declare `native.clipboard.write` is not granted it, and the call rejects
 * before a frame is sent; the callers' own `catch` puts that on screen.
 */
export function useClipboardWriter(): ClipboardWriter {
  const verbs = useNativeVerbs()

  return useMemo(
    () => ({
      writeText: async (value) => {
        if (!(await verbs.writeClipboardText(value))) {
          throw new Error('the clipboard did not accept this text')
        }
      }
    }),
    [verbs]
  )
}

/**
 * Web sibling: the shell reads text for the page with one verb and stages an image with three.
 *
 * `native.clipboard.read` is text and only text: `BRIDGE_CLIPBOARD_MIMES` is `['text']`, so an
 * image mime is not a refusal the verb spells out but a value its schema does not admit, answered
 * `invalid-params`. Widening it cannot work — `CLIPBOARD_IMAGE_MAX_BASE64_CHARS` is 24 MiB against
 * a reply cap of 8 MiB. So an image on the pasteboard is `native.media.pick { source: 'clipboard' }`
 * instead: the shell stages it and answers a handle, the bytes come back a chunk at a time under
 * the frame cap, and the handle goes back. The result is the same `{ data, size }` the phone's
 * `getImageAsync` answers, so the terminal's paste and the upload path below it are unchanged.
 *
 * Null still means "nothing there", which is what an empty pasteboard answers on both platforms
 * and the branch the paste already takes. Every other outcome rejects, because a refused pick and
 * an empty clipboard lead a caller to different screens.
 *
 * `contents` cannot be a probe. The shell serves no "is there text" verb and reading to find out
 * would raise iOS's paste-consent prompt on every mount and every foreground, which is the whole
 * reason `hasStringAsync` exists. So it answers what this side actually knows: a shell that granted
 * the read verb may have text, and one that granted the media verbs may have an image. The paste
 * button is enabled on a maybe and the read is what settles it, which is the same order a phone
 * runs when the probe throws.
 *
 * Per grant, not on the pair: a route granted only `native.clipboard.read` can paste text, and
 * answering on both would tell it its clipboard is empty.
 */
export function useClipboardReader(): ClipboardReader {
  const verbs = useNativeVerbs()

  return useMemo(
    () => ({
      readText: async () => await verbs.readClipboardText(),
      readImage: async (): Promise<ClipboardImage | null> => {
        const picked = await verbs.pickMedia('clipboard', false)
        const [image] = picked
        if (image === undefined) {
          return null
        }
        try {
          return {
            data: await readStagedMediaItem(verbs, image),
            // Zero when the pasteboard reported no dimensions, which is what the downscale loop
            // already reads as "cannot resize this": the upload path's own size check then refuses
            // an image too large rather than this seam guessing a raster size for it.
            size: { width: image.width ?? 0, height: image.height ?? 0 }
          }
        } finally {
          await releaseAllStagedMedia(verbs, picked)
        }
      },
      contents: async () =>
        await Promise.resolve({ text: verbs.canReadClipboardText, image: verbs.canPickMedia })
    }),
    [verbs]
  )
}
