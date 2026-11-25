import {
  isPtyFencedTerminationOutcome,
  type PtyFencedTerminationLocalOptions,
  type PtyFencedTerminationOutcome,
  type PtyFencedTerminationRequest
} from '../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'

export type DaemonPtyFencedKillDeps = {
  supportsFencedTermination: (id: string) => boolean
  withHistorySpawnLock: <T>(id: string, run: () => Promise<T>) => Promise<T>
  sessionIncarnation: (id: string) => string | undefined
  ensureConnected: () => Promise<void>
  requestKill: (args: {
    sessionId: string
    immediate: true
    expectedIncarnationId: string
    requireNoAgentOwner: boolean
    requireUnattached: boolean
  }) => Promise<unknown>
  completeShutdownWithHistoryLock: (id: string, opts: { keepHistory?: boolean }) => Promise<void>
}

/** One exact-incarnation stop through the daemon, holding the spawn lock through local removal. */
export async function killDaemonPtyFenced(
  deps: DaemonPtyFencedKillDeps,
  request: PtyFencedTerminationRequest,
  options?: PtyFencedTerminationLocalOptions
): Promise<PtyFencedTerminationOutcome> {
  if (!deps.supportsFencedTermination(request.id)) {
    return { outcome: 'refused', reason: 'unsupported' }
  }
  // Capture the checked identity before waiting on connection or lifecycle locks.
  const { id, expectedIncarnationId, requireNoAgentOwner, requireUnattached } = request
  try {
    return await deps.withHistorySpawnLock(id, async (): Promise<PtyFencedTerminationOutcome> => {
      const incarnationBeforeKill = deps.sessionIncarnation(id)
      await deps.ensureConnected()
      // The caller's grant may have changed during the lock and connection waits.
      if (options?.beforeRequest?.() === false) {
        return { outcome: 'refused', reason: 'unverifiable' }
      }
      const result = await deps.requestKill({
        sessionId: id,
        immediate: true,
        expectedIncarnationId,
        requireNoAgentOwner,
        requireUnattached
      })
      if (!isPtyFencedTerminationOutcome(result)) {
        return { outcome: 'refused', reason: 'unverifiable' }
      }
      const currentIncarnationId = deps.sessionIncarnation(id)
      if (
        (result.outcome === 'ended' || result.outcome === 'already_exited') &&
        (incarnationBeforeKill === undefined || incarnationBeforeKill === expectedIncarnationId) &&
        (currentIncarnationId === undefined || currentIncarnationId === expectedIncarnationId)
      ) {
        // Exit may clear the incarnation first; hold the spawn lock through removal to protect replacement sessions.
        await deps.completeShutdownWithHistoryLock(id, {
          keepHistory: options?.keepHistory === true
        })
      }
      return result
    })
  } catch {
    return { outcome: 'refused', reason: 'unverifiable' }
  }
}
