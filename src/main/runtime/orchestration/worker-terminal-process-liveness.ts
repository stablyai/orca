import type { PtyProcessInfo } from '../../providers/pty-process-info'

// One reader for the durable `host_scope` column; re-exported so the process-liveness
// path keeps its import site while the parse itself lives beside the fleet consumers.
export type { WorkerTerminalHostScope } from '../../../shared/worker-terminal-host-scope'
export { parseWorkerTerminalHostScope } from '../../../shared/worker-terminal-host-scope'

export function classifyWorkerTerminalProcessIncarnation(
  processIncarnation: string,
  sessions: readonly PtyProcessInfo[]
): 'live' | 'exited' | 'unverifiable' {
  const possibleMatches = sessions.filter((session) =>
    processIncarnation.startsWith(`${session.id}:`)
  )
  if (
    possibleMatches.some((session) => {
      const incarnationId = session.incarnationId
      if (!incarnationId || incarnationId !== incarnationId.trim()) {
        return false
      }
      return `${session.id}:${incarnationId}` === processIncarnation
    })
  ) {
    return 'live'
  }
  // An empty listing is not proof of death — it is equally the shape of a host that never
  // enumerated this scope (in-process-only local inventory, a relay that restarted and forgot
  // every prior id, a partial enumeration). Only a listing that names this pty id under a
  // *different* incarnation is positive remint evidence that the old process is gone.
  if (possibleMatches.length === 0) {
    return 'unverifiable'
  }
  return possibleMatches.some(
    (session) => !session.incarnationId || session.incarnationId !== session.incarnationId.trim()
  )
    ? 'unverifiable'
    : 'exited'
}
