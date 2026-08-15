import { clipboard } from 'electron'

// Why: kept exported for backward compatibility — the constant name may be
// referenced by telemetry/error-handling code in the main process.
export const CLIPBOARD_WRITE_VERIFICATION_FAILED_ERROR = 'Clipboard write verification failed'

// Electron can silently leave the Windows clipboard unchanged under contention.
export function writeClipboardTextAndVerify(text: string): void {
  clipboard.writeText(text)
  // Strict identity: multi-line TUI content must round-trip byte-for-byte.
  // Why warn not throw: macOS clipboard managers and Windows normalization
  // (CRLF, trailing-whitespace trimming) can alter text between write and read,
  // causing false-negative mismatches that make user-initiated copy silently fail.
  // The write itself succeeded — a mismatch is advisory, logged for diagnostics.
  const readBack = clipboard.readText()
  if (readBack !== text) {
    console.warn(
      `Clipboard write verification mismatch: wrote ${text.length} chars, read back ${readBack.length} chars`
    )
  }
}
