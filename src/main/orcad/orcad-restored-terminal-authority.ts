import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcadFeatureReadiness } from '../runtime/rpc/orcad-feature-readiness'
import { placeUnshownLiveTerminalsBestEffort } from '../runtime/terminal/adoption/unshown-live-terminal-placement'
import type { createOrcadStartupTiming } from './orcad-startup-timing'

/** Restored orchestration authority, the legacy terminal reconcile and unshown placement, in order. */
export async function restoreOrcadTerminalAuthority(
  runtime: OrcaRuntimeService,
  timed: ReturnType<typeof createOrcadStartupTiming>['time'],
  readiness: OrcadFeatureReadiness
): Promise<void> {
  await timed('orchestration', () => runtime.refreshRestoredOrchestrationAuthority())
  readiness.open('orchestration')
  // Terminal inventory stays on the critical path: no latch, every client needs it at connect.
  await timed('reconcile-terminals', () => runtime.reconcileLegacyWorkerTerminals())
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await placeUnshownLiveTerminalsBestEffort(runtime)
  }
  readiness.open('unshownPlacement')
}
