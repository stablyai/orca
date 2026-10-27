import { connectionLogStore } from '../transport/persisted-connection-log-store'
import type { ConnectionLogEntry } from '../transport/types'

// Keep the shared 200-entry connection log sparse: healthy opens need only paint, with failures/stalls filling gaps. Exclude route paths, device directories and stacks.
export type ShellLifecycleLine = Required<Pick<ConnectionLogEntry, 'level' | 'message' | 'code'>> &
  Pick<ConnectionLogEntry, 'detail'>

let lineSequence = 0

const FLAPPING_MESSAGES: ReadonlySet<string> = new Set([
  'Web shell: checking host',
  'Web shell: host unreachable and no app cached'
])
// Suppress repeated flapping lines per host until a different shell milestone occurs.
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
