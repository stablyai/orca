import type { OrcadManagedStopRequest } from '../../shared/orcad-stop-request'
import { persistOrcadDaemonRetirementRecord } from './orcad-completed-stop-receipt'
import type { OrcadDaemonRetirement } from './orcad-daemon-retirement'

// Lazy like the rest of orcad's daemon graph: the entry module must not load it at import time.
async function retireLazily(): Promise<OrcadDaemonRetirement> {
  const { retireOrcadDaemonIfIdle } = await import('./orcad-daemon-retirement')
  return retireOrcadDaemonIfIdle()
}

/** Runs before orcad stops for a managed request; it can record an outcome but never veto. */
export async function prepareOrcadManagedStop(
  request: OrcadManagedStopRequest,
  retire: () => Promise<OrcadDaemonRetirement> = retireLazily
): Promise<void> {
  if (!request.retireIdleDaemon) {
    return
  }
  const outcome = await retire().catch((error: unknown): OrcadDaemonRetirement => ({
    retirement: 'unverifiable',
    liveSessions: null,
    reason: `Retirement failed: ${error instanceof Error ? error.message : String(error)}`
  }))
  try {
    persistOrcadDaemonRetirementRecord(request, outcome)
  } catch (error) {
    // The completion command reads a missing record as `unverifiable`.
    console.error('[orcad] could not record daemon retirement:', error)
  }
}
