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

/**
 * What is on the clipboard, without reading it.
 *
 * Two flags rather than one because the callers act on them differently: text pastes into the
 * terminal as keystrokes and an image is uploaded first, and the accessory row enables its paste
 * button for either.
 */
export type ClipboardContents = { text: boolean; image: boolean }

/**
 * A PNG off the clipboard, in the shape the image upload path already takes.
 *
 * Structural rather than re-exported from `expo-clipboard`, so the web sibling can answer without
 * the package: a type imported from a module the page never loads is a runtime import the bundler
 * cannot drop.
 */
export type ClipboardImage = { data: string; size: { width: number; height: number } }

/**
 * Reading the device clipboard, which is three calls on a phone and one verb on the web.
 *
 * `readImage` answers null for "nothing there", which is what `getImageAsync` answers and what the
 * terminal's paste already branches on — so the page's lack of an image verb degrades into the
 * path that was always there rather than into a new error.
 */
export type ClipboardReader = {
  readText: () => Promise<string>
  readImage: () => Promise<ClipboardImage | null>
  contents: () => Promise<ClipboardContents>
}

export function useClipboardReader(): ClipboardReader {
  return useMemo(
    () => ({
      readText: async () => await Clipboard.getStringAsync(),
      readImage: async () => await Clipboard.getImageAsync({ format: 'png' }),
      // Swallowed here rather than at each caller, which is where it already was: a probe that
      // threw would disable the paste button, and every platform reason for it to throw is one
      // the read itself reports better.
      // Both probes started before either is awaited, which is what the call sites did before this
      // seam existed. Awaiting them in turn puts an IPC round trip on the critical path of every
      // mount, every foreground and every select-mode toggle.
      contents: async () => {
        const [text, image] = await Promise.all([
          Clipboard.hasStringAsync().catch(() => false),
          Clipboard.hasImageAsync().catch(() => false)
        ])
        return { text, image }
      }
    }),
    []
  )
}
