import { useMemo } from 'react'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { ClipboardWriter } from './clipboard'

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
