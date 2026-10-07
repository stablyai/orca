// Which ports a WebSocket listener may bind, and in what order. Kept out of the transport so the ordering
// rules — persisted fallback (STA-1511), pin preference (issue #8535), OS-assigned relocation (STA-7721) —
// are decided once, up front, and are testable without opening a socket.

export type BindPortCandidate = {
  port: number
  // Why: a persisted fallback is a guess from a previous launch, so ANY error on it falls through to the next
  // candidate. A configured port only falls through when its listen was occupied or denied.
  tolerateAnyError: boolean
}

export function resolveBindPortCandidates(options: {
  port: number
  fallbackPort: number | undefined
  preferPinnedPort: boolean
  allowOsAssignedPortFallback: boolean
}): BindPortCandidate[] {
  const { port, fallbackPort, preferPinnedPort, allowOsAssignedPortFallback } = options
  // Why: a fallback equal to the configured port (or 0) is not a distinct candidate.
  const persistedFallbackPort =
    fallbackPort !== undefined && fallbackPort !== 0 && fallbackPort !== port
      ? fallbackPort
      : undefined
  const pin: BindPortCandidate = { port, tolerateAnyError: false }
  const configured =
    persistedFallbackPort === undefined
      ? [pin]
      : // Why: bind a persisted fallback first so devices paired to it aren't stranded (STA-1511); `serve
        // --port` flips to pinned-first so a stale fallback can't steal the pin (issue #8535).
        preferPinnedPort
        ? [pin, { port: persistedFallbackPort, tolerateAnyError: true }]
        : [{ port: persistedFallbackPort, tolerateAnyError: true }, pin]
  // Why: STA-7721 — port 0 lets the OS relocate the listener anywhere. That is only safe on the FIRST bind of
  // a session, when no endpoint has been published yet. A rebind of an already-advertised listener leaves it
  // off the list, so an occupied port surfaces as a bind error instead of a silent move to a port that
  // nothing is dialling. Appended last, and never twice — a configured port of 0 already relocates.
  return allowOsAssignedPortFallback && !configured.some((candidate) => candidate.port === 0)
    ? [...configured, { port: 0, tolerateAnyError: false }]
    : configured
}

// Why: only an occupied or denied listen is a reason to try the next candidate; anything else is a real
// failure. EACCES is scoped to this port's listen so an unrelated EACCES still propagates.
export function isPortListenFallbackError(error: unknown, port: number): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false
  }
  if (error.code === 'EADDRINUSE') {
    return true
  }
  return (
    error.code === 'EACCES' &&
    'syscall' in error &&
    error.syscall === 'listen' &&
    'port' in error &&
    error.port === port
  )
}
