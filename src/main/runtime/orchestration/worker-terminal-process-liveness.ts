import type { PtyProcessInfo } from '../../providers/pty-process-info'

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

/** Exact live match proves life; missing/dirty candidate incarnation remains unverifiable, otherwise classify exited. */
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
