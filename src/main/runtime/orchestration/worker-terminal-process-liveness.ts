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

export function classifyWorkerTerminalProcessIncarnation(
  processIncarnation: string,
  sessions: readonly PtyProcessInfo[]
): 'live' | 'dead' | 'unknown' {
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
    ? 'unknown'
    : 'dead'
}
