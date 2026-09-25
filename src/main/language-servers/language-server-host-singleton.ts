// Process-wide language-server host singleton (spec §4). Split out of
// language-server-host.ts so the host module stays under its line budget; the
// singleton binds the production event surface (log to stdout) and leaves the
// version gate to the per-host adapter (native PATH probe or guest clangd
// probe, selected per worktree by `selectHostAdapter`).
import { createLanguageServerHost, type LanguageServerHost } from './language-server-host'
import { openClangdSession } from './clangd-session'
import type { LanguageServerHostEvents } from './language-server-host-types'

let hostSingleton: LanguageServerHost | null = null

/** Process-wide host. Events bind at first creation; later events are ignored. */
export function getLanguageServerHost(events: LanguageServerHostEvents = {}): LanguageServerHost {
  if (hostSingleton) {
    return hostSingleton
  }
  // versionGate=null: the host delegates to the adapter's gate per worktree
  // (native clangd --version or guest clangd --version via wsl.exe --exec).
  hostSingleton = createLanguageServerHost(
    { onLog: (line) => console.log(line), ...events },
    openClangdSession,
    null
  )
  return hostSingleton
}

/** Test seam: reset the process-wide singleton. */
export function resetLanguageServerHostForTests(): void {
  hostSingleton = null
}
