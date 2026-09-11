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
  return possibleMatches.some(
    (session) => !session.incarnationId || session.incarnationId !== session.incarnationId.trim()
  )
    ? 'unverifiable'
    : 'exited'
}
