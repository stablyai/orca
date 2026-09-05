import type { PtyProcessInfo } from '../../providers/pty-process-info'

export type WorkerTerminalHostScope =
  | { kind: 'local'; hostId: 'local' }
  | { kind: 'wsl'; hostId: 'local'; distro: string }
  | { kind: 'ssh'; targetId: string }

export function parseWorkerTerminalHostScope(value: string | null): WorkerTerminalHostScope | null {
  if (!value) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const scope = parsed as Record<string, unknown>
  if (scope.kind === 'local' && scope.hostId === 'local') {
    return { kind: 'local', hostId: 'local' }
  }
  if (
    scope.kind === 'wsl' &&
    scope.hostId === 'local' &&
    typeof scope.distro === 'string' &&
    scope.distro.length > 0
  ) {
    return { kind: 'wsl', hostId: 'local', distro: scope.distro }
  }
  if (scope.kind === 'ssh' && typeof scope.targetId === 'string' && scope.targetId.length > 0) {
    return { kind: 'ssh', targetId: scope.targetId }
  }
  return null
}

// Does `processIncarnation` name exactly this pty's live incarnation? Anchors on the pty id as a
// prefix and then requires exact `${ptyId}:${incarnationId}` equality, so it is immune to colons
// on either side (relay/SSH ptyIds, colon-bearing relay incarnationIds). A pty with no (or a
// whitespace-dirty) incarnationId can never match — the exact-incarnation fence stays intact.
export function matchesProcessIncarnation(
  ptyId: string,
  incarnationId: string | null | undefined,
  processIncarnation: string
): boolean {
  if (!incarnationId || incarnationId !== incarnationId.trim()) {
    return false
  }
  if (!processIncarnation.startsWith(`${ptyId}:`)) {
    return false
  }
  return `${ptyId}:${incarnationId}` === processIncarnation
}

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
