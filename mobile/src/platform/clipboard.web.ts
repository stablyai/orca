import { useMemo } from 'react'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { ClipboardReader, ClipboardWriter } from './clipboard'

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
 * Web sibling: the shell reads text for the page, and no shell reads an image for it yet.
 *
 * `native.clipboard.read` serves text and refuses `{ mime: 'image' }` by name. Widening it cannot
 * work — `CLIPBOARD_IMAGE_MAX_BASE64_CHARS` is 24 MiB against a reply cap of 8 MiB — so an image
 * is the media verbs' job and is not served here. `readImage` therefore answers null, which is the
 * answer an empty clipboard already gives, and the terminal's paste takes the branch it has always
 * taken for one. A recorded degradation, not a silent one: on the page an image on the clipboard
 * pastes nothing until the media verbs land.
 *
 * `contents` cannot be a probe. The shell serves no "is there text" verb and reading to find out
 * would raise iOS's paste-consent prompt on every mount and every foreground, which is the whole
 * reason `hasStringAsync` exists. So it answers what this side actually knows: a shell that granted
 * the read verb may have text, and no shell has an image. The paste button is enabled on a maybe
 * and the read is what settles it, which is the same order a phone runs when the probe throws.
 */
export function useClipboardReader(): ClipboardReader {
  const verbs = useNativeVerbs()

  return useMemo(
    () => ({
      readText: async () => await verbs.readClipboardText(),
      readImage: async () => await Promise.resolve(null),
      contents: async () => await Promise.resolve({ text: verbs.granted, image: false })
    }),
    [verbs]
  )
}
