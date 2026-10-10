import type { PtyProcessInfo } from '../../providers/pty-process-info'

// One reader for the durable `host_scope` column; re-exported so the process-liveness
// path keeps its import site while the parse itself lives beside the fleet consumers.
export type { WorkerTerminalHostScope } from '../../../shared/worker-terminal-host-scope'
export { parseWorkerTerminalHostScope } from '../../../shared/worker-terminal-host-scope'

/**
 * Does `processIncarnation` name exactly this pty's live incarnation? Requires exact
 * `${ptyId}:${incarnationId}` equality, so it is immune to colons on either side (relay/SSH
 * ptyIds, colon-bearing relay incarnationIds). A pty with no (or a whitespace-dirty)
 * incarnationId can never match — the exact-incarnation fence stays intact.
 */
export function matchesProcessIncarnation(
  ptyId: string,
  incarnationId: string | null | undefined,
  processIncarnation: string
): boolean {
  if (!incarnationId || incarnationId !== incarnationId.trim()) {
    return false
  }
  return `${ptyId}:${incarnationId}` === processIncarnation
}

/** Classify a recorded incarnation against live sessions: live on exact match, unverifiable when a candidate pty has a dirty or absent incarnationId (lost contact is never a death certificate), else exited. */
export function classifyWorkerTerminalProcessIncarnation(
  processIncarnation: string,
  sessions: readonly PtyProcessInfo[]
): 'live' | 'exited' | 'unverifiable' {
  const possibleMatches = sessions.filter((session) =>
    processIncarnation.startsWith(`${session.id}:`)
  )
  if (
    possibleMatches.some((session) =>
      matchesProcessIncarnation(session.id, session.incarnationId, processIncarnation)
    )
  ) {
    return 'live'
  }
  return possibleMatches.some(
    (session) => !session.incarnationId || session.incarnationId !== session.incarnationId.trim()
  )
    ? 'unverifiable'
    : 'exited'
}
