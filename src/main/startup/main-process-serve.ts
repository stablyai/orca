import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { notifyServeSupervisorReady } from '../serve-update-handoff'
import { buildServePairingReadiness, servePublishMode } from '../server/serve-pairing-readiness'
import { mainProcessState as state } from './main-process-state'
import { getServeOptions, type ServeOptions } from './serve-options'

export { getServeOptions, type ServeOptions }

export function getBundledWebClientRoot(): string | undefined {
  const appPath = app.getAppPath()
  const roots = [
    join(appPath, 'out', 'web'),
    // Why: unpacked electron-vite entrypoints set appPath to out/main, next to the web bundle.
    join(appPath, '..', 'web')
  ]
  return roots.find((root) => existsSync(join(root, 'web-index.html')))
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
}
