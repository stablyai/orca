import { clipboard } from 'electron'
import { publishClipboardText } from './clipboard-text-publisher'

// A copied secret (a webhook key) leaves the clipboard after a minute, unless something else replaced it.
export const SECRET_CLIPBOARD_CLEAR_MS = 60_000

type SecretClipboardDeps<Timer> = {
  readText: () => Promise<string>
  clear: () => Promise<void>
  setTimer: (run: () => void, ms: number) => Timer
  clearTimer: (timer: Timer) => void
}

export function createSecretClipboardClearer<Timer>(
  deps: SecretClipboardDeps<Timer>
): (text: string) => void {
  let pending: Timer | null = null
  let generation = 0
  return (text) => {
    if (pending !== null) {
      deps.clearTimer(pending)
    }
    const scheduled = ++generation
    pending = deps.setTimer(() => {
      pending = null
      void deps
        .readText()
        // A newer secret supersedes a read already in flight.
        .then((current) =>
          current === text && scheduled === generation ? deps.clear() : undefined
        )
        .catch((error: unknown) => {
          console.error('[clipboard] secret clear failed', error)
        })
    }, SECRET_CLIPBOARD_CLEAR_MS)
  }
}

/** Wired to the system clipboard, for clipboard:writeSecretText. */
export const clearSecretFromClipboard = createSecretClipboardClearer({
  readText: () => clipboard.readText(),
  // The same publisher wrote the secret: on Wayland only its helper owns the clipboard.
  clear: () => publishClipboardText('', 'ordinary'),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer)
})
