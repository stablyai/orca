import { app } from 'electron'
import { notifyServeSupervisorReady } from '../serve-update-handoff'
import { clearServeAbortPark } from '../../shared/serve-abort-park'
import { findBundledWebClientRoot } from '../../shared/bundled-web-client-root'
import { buildServePairingReadiness, servePublishMode } from '../server/serve-pairing-readiness'
import { mainProcessState as state } from './main-process-state'
import { getServeOptions, type ServeOptions } from './serve-options'

export { getServeOptions, type ServeOptions }

export function getBundledWebClientRoot(): string | undefined {
  return findBundledWebClientRoot(app.getAppPath())
}

export async function printServeReady(options: ServeOptions): Promise<void> {
  const runtime = state.runtime
  const runtimeRpc = state.runtimeRpc
  if (!runtime || !runtimeRpc) {
    throw new Error('Runtime server must be initialized before printing serve readiness')
  }
  // Why first: an invalid project root must fail before createPairingOffer saves a pending device.
  const output = servePublishMode(options)
  await state.serveReadinessPublisher.publish(
    {
      runtimeId: runtime.getRuntimeId(),
      ...(await buildServePairingReadiness(options, runtimeRpc)),
      // Why: the WSL reconciliation barrier fails open, so 'pending' warns a WSL PTY launch may still race a repair.
      managedWslCliReconciliation: state.managedWslCliReconciliationStatus
    },
    output
  )
  notifyServeSupervisorReady(runtime.getRuntimeId())
  // Why: a serve that got this far proves this environment can launch it after all.
  clearServeAbortPark(app.getPath('userData'))
}
