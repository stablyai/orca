import { connectionLogStore } from '../transport/persisted-connection-log-store'
import type { ConnectionLogEntry } from '../transport/types'

/**
 * Sparse OTA shell milestones for the per-host connection log, so an exported report says where a
 * workspace open stalled. Diagnostics only: nothing here feeds back into the session.
 *
 * The store holds 200 entries shared with connection events and every page route mounts its own
 * shell, so a healthy open writes one line (the paint); the rest are failures and one-shot stall
 * warnings. Route paths, generation directories and error stacks stay out: they can name user paths.
 */
export type ShellLifecycleLine = Required<Pick<ConnectionLogEntry, 'level' | 'message' | 'code'>> &
  Pick<ConnectionLogEntry, 'detail'>

let lineSequence = 0

// Lines a host flapping between unreachable and dialling would repeat every cycle per mounted shell.
const FLAPPING_MESSAGES: ReadonlySet<string> = new Set([
  'Web shell: checking host',
  'Web shell: host unreachable and no app cached'
])
// Per host, the flapping lines already written since the last other shell line for it.
const flappingWritten = new Map<string, Set<string>>()

export function recordShellLifecycleLine(hostId: string, line: ShellLifecycleLine): void {
  if (FLAPPING_MESSAGES.has(line.message)) {
    const written = flappingWritten.get(hostId) ?? new Set<string>()
    if (written.has(line.message)) {
      return
    }
    written.add(line.message)
    flappingWritten.set(hostId, written)
  } else {
    flappingWritten.delete(hostId)
  }
  const ts = Date.now()
  lineSequence += 1
  connectionLogStore.append(hostId, { id: `web-shell-${ts}-${lineSequence}`, ts, ...line })
}
