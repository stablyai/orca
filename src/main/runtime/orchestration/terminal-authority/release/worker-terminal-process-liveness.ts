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

/** A host's listed sessions by id, so each incarnation looks up its few candidates instead of scanning. */
export type WorkerTerminalProcessIndex = ReadonlyMap<string, readonly PtyProcessInfo[]>

export function indexWorkerTerminalProcesses(
  sessions: readonly PtyProcessInfo[]
): WorkerTerminalProcessIndex {
  const index = new Map<string, PtyProcessInfo[]>()
  for (const session of sessions) {
    const same = index.get(session.id)
    if (same) {
      same.push(session)
    } else {
      index.set(session.id, [session])
    }
  }
  return index
}

/** The same verdict as the list form; a pty id may itself contain colons, so try each prefix. */
export function classifyIndexedWorkerTerminalProcessIncarnation(
  processIncarnation: string,
  index: WorkerTerminalProcessIndex
): 'live' | 'exited' | 'unverifiable' {
  const candidates: PtyProcessInfo[] = []
  for (
    let at = processIncarnation.indexOf(':');
    at >= 0;
    at = processIncarnation.indexOf(':', at + 1)
  ) {
    candidates.push(...(index.get(processIncarnation.slice(0, at)) ?? []))
  }
  return classifyWorkerTerminalProcessIncarnation(processIncarnation, candidates)
}

const MINTED_INCARNATION = /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A `ptyId:<uuid>` identity a current PTY minted; a legacy `runtime:pty:generation` fence is not one,
 *  and absence from a list proves nothing about it. */
export function isMintedPtyIncarnation(processIncarnation: string): boolean {
  return MINTED_INCARNATION.test(processIncarnation)
}
