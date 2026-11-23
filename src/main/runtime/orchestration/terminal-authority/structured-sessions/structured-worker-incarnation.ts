// A structured worker's process incarnation names its session; dependency-free, so the orchestration
// reader thread can key its reads by it.
export const STRUCTURED_WORKER_INCARNATION_PREFIX = 'structured:'

/** Use stable session lineage for process continuity; transparent crash recovery bumps the owner fence and must not wedge the same worker as identity_unproven. */
export function structuredWorkerProcessIncarnation(sessionId: string): string {
  return `${STRUCTURED_WORKER_INCARNATION_PREFIX}${sessionId}`
}

export function sessionIdFromStructuredWorkerIncarnation(
  processIncarnation: string | null | undefined
): string | null {
  if (!processIncarnation?.startsWith(STRUCTURED_WORKER_INCARNATION_PREFIX)) {
    return null
  }
  const sessionId = processIncarnation.slice(STRUCTURED_WORKER_INCARNATION_PREFIX.length)
  return sessionId.length > 0 ? sessionId : null
}
