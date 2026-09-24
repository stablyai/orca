// Process-wide language-server host singleton (spec §4). Split out of
// language-server-host.ts so the host module stays under its line budget; the
// singleton binds the production event surface (log to stdout) and the real
// clangd version gate + compile-db strategy.
import { createLanguageServerHost, type LanguageServerHost } from './language-server-host'
import { openClangdSession } from './clangd-session'
import { resolveClangdVersionGate } from './clangd-launch'
import type { LanguageServerHostEvents } from './language-server-host-types'

let hostSingleton: LanguageServerHost | null = null

/** Process-wide host. Events bind at first creation; later events are ignored. */
export function getLanguageServerHost(events: LanguageServerHostEvents = {}): LanguageServerHost {
  if (hostSingleton) {
    return hostSingleton
  }
  hostSingleton = createLanguageServerHost(
    { onLog: (line) => console.log(line), ...events },
    openClangdSession,
    resolveClangdVersionGate
  )
  return hostSingleton
}

/** Test seam: reset the process-wide singleton. */
export function resetLanguageServerHostForTests(): void {
  hostSingleton = null
}
