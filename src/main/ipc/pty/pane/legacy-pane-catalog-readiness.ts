import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import type { TerminalHistoryRoot } from '../../../daemon/history/storage/terminal-history-root'
import type { LegacyTerminalIdentityClaims } from '../../../persistence/loading-store/legacy-terminal-identity-claims'
import type { LegacyTerminalRestoreAttempt } from '../../../pty/legacy-terminal-restore-ownership'

export async function prepareLegacyPaneCatalogReadiness(
  root: TerminalHistoryRoot,
  claims: LegacyTerminalIdentityClaims,
  attempt: LegacyTerminalRestoreAttempt,
  signal: AbortSignal | undefined,
  hasCanonical: () => boolean
): Promise<boolean> {
  const waiting = {
    signal: signal ? AbortSignal.any([signal, attempt.close.signal]) : attempt.close.signal,
    createAbortError: () =>
      attempt.closed
        ? new Error('terminal_pane_owner_changed')
        : (signal?.reason ?? new Error('client_disconnected'))
  }
  await sharedPromiseSettlementWaiters(
    Promise.all([root.profileReady(), claims.canonicalProfileReady])
  ).wait(waiting)
  if (!root.matchesProfile(claims.canonicalProfile)) {
    return false
  }
  if (attempt.closed) {
    throw new Error('terminal_pane_owner_changed')
  }
  if (!hasCanonical() && !attempt.catalogDeclined) {
    const remaining = attempt.readinessDeadline - Date.now()
    try {
      const complete =
        attempt.catalog.complete ||
        (remaining > 0 &&
          (await sharedPromiseSettlementWaiters(attempt.catalog.ready).wait({
            ...waiting,
            timeoutMs: remaining
          })))
      if (!complete || attempt.catalog !== claims.captureExternalCatalog()) {
        attempt.catalogDeclined = true
      }
    } catch (error) {
      if (attempt.closed || signal?.aborted) {
        throw error
      }
      attempt.catalogDeclined = true
    }
  }
  return hasCanonical() || !attempt.catalogDeclined
}
