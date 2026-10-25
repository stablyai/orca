import type { OrcadManagedStopRequest } from '../../shared/orcad-stop-request'
import { persistOrcadDaemonRetirementRecord } from './orcad-completed-stop-receipt'
import type { OrcadDaemonRetirement } from './orcad-daemon-retirement'
import { stopOrcadAutomationScheduler } from './orcad-automations'
import { holdOrcadTerminalAdmissionUntilExit } from './orcad-stop-terminal-admission'

// Keep daemon imports lazy so entry loading cannot initialize native code.
async function retireLazily(): Promise<OrcadDaemonRetirement> {
  const { retireOrcadDaemonIfIdle } = await import('./orcad-daemon-retirement')
  return retireOrcadDaemonIfIdle()
}

/** Record managed-stop outcomes without vetoing the stop. */
export async function prepareOrcadManagedStop(
  request: OrcadManagedStopRequest,
  retire: () => Promise<OrcadDaemonRetirement> = retireLazily,
  stopAutomations: () => void = stopOrcadAutomationScheduler,
  holdTerminalAdmission: () => void = holdOrcadTerminalAdmissionUntilExit
): Promise<void> {
  // Fence spawns before potentially slow daemon retirement.
  holdTerminalAdmission()
  // Stop dispatch before census so new runs cannot race shutdown.
  stopAutomations()
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
    // Missing retirement records remain unverifiable to the completion reader.
    console.error('[orcad] could not record daemon retirement:', error)
  }
}
