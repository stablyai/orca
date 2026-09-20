import { useMemo } from 'react'
import * as Clipboard from 'expo-clipboard'

/**
 * Writing text to the device clipboard, which is one call on a phone and a request to the shell
 * on the web.
 *
 * A hook rather than a function because the web sibling needs the page's bridge client, which is
 * React context. Rejecting is how it reports failure: every caller is an async handler with a
 * `catch` that puts the message on screen, so a write that did not land says so rather than
 * silently claiming to have copied.
 */
export type ClipboardWriter = { writeText: (value: string) => Promise<void> }

export function useClipboardWriter(): ClipboardWriter {
  return useMemo(
    () => ({
      writeText: async (value) => {
        // `setStringAsync` answers whether the pasteboard took it, and a caller showing "Copied"
        // over a write that did not land is the failure this seam exists to avoid.
        if (!(await Clipboard.setStringAsync(value))) {
          throw new Error('the clipboard did not accept this text')
        }
      }
    }),
    []
  )
}
