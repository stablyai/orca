import type { PtyProcessInfo } from '../../../../providers/pty/process-info'

/** Match the whole ptyId:incarnationId exactly, including embedded colons; absent or whitespace-dirty incarnation cannot attest identity. */
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

// Current fences end in a minted UUID; legacy `runtimeId:ptyId:generation` ends in a number.
const MINTED_INCARNATION_SUFFIX = /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Exact live match proves life; absence proves exit only for a current fence the answering owner can vouch for. */
export function classifyWorkerTerminalProcessIncarnation(
  processIncarnation: string,
  sessions: readonly PtyProcessInfo[],
  absenceProvesExit: boolean
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
  if (!absenceProvesExit || !MINTED_INCARNATION_SUFFIX.test(processIncarnation)) {
    return 'unverifiable'
  }
  return possibleMatches.some(
    (session) => !session.incarnationId || session.incarnationId !== session.incarnationId.trim()
  )
    ? 'unverifiable'
    : 'exited'
}
