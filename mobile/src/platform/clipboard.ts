import { useMemo } from 'react'
import * as Clipboard from 'expo-clipboard'

// Expose a hook for the web sibling’s bridge context; reject failed writes so callers cannot show Copied for a write that never landed.
export type ClipboardWriter = { writeText: (value: string) => Promise<void> }

export function useClipboardWriter(): ClipboardWriter {
  return useMemo(
    () => ({
      writeText: async (value) => {
        // False means the pasteboard refused the write; do not claim it copied.
        if (!(await Clipboard.setStringAsync(value))) {
          throw new Error('the clipboard did not accept this text')
        }
      }
    }),
    []
  )
}

// Keep text/image availability separate: text becomes keystrokes while images upload before paste.
export type ClipboardContents = { text: boolean; image: boolean }

// Keep the image shape independent of Expo so the page can provide it without importing the native package.
export type ClipboardImage = { data: string; size: { width: number; height: number } }

// Keep clipboard ownership here and picker ownership in media. The page stages/chunks images because base64 can exceed the reply cap.
// Only an empty clipboard returns null; refusals reject so callers can distinguish failure from absence.
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
      // Treat probe failures as maybe-present and let actual reads report errors; start both probes before awaiting to avoid serial IPC latency.
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
