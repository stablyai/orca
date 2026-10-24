import { watchFile, unwatchFile, type Stats } from 'node:fs'
import { join } from 'node:path'

/** Watches metadata only; atomic credential replacement must survive the watch. */
export function watchClaudeCredentials(configDir: string, onChange: () => void): () => void {
  const path = join(configDir, '.credentials.json')
  let closed = false
  const listener = (current: Stats, previous: Stats): void => {
    if (
      !closed &&
      current.size > 0 &&
      (current.mtimeMs !== previous.mtimeMs ||
        current.ctimeMs !== previous.ctimeMs ||
        current.size !== previous.size ||
        current.ino !== previous.ino)
    ) {
      onChange()
    }
  }
  watchFile(path, { persistent: false, interval: 2_000 }, listener)
  return () => {
    closed = true
    unwatchFile(path, listener)
  }
}
