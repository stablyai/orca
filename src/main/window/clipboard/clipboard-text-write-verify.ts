import { clipboard } from 'electron'

export const CLIPBOARD_WRITE_VERIFICATION_FAILED_ERROR = 'Clipboard write verification failed'

// Electron can silently leave the Windows clipboard unchanged under contention.
export function writeClipboardTextAndVerify(text: string): void {
  clipboard.writeText(text)
  // Strict identity: multi-line TUI content must round-trip byte-for-byte.
  if (clipboard.readText() !== text) {
    throw new Error(CLIPBOARD_WRITE_VERIFICATION_FAILED_ERROR)
  }
}
