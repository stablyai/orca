import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdaterWaitResult
} from '../../shared/remote-server-update'
import type { UpdateCheckOptions } from '../../shared/update-status-types'

type RemoteServerUpdaterAdapter = {
  getSnapshot: (runtimeId: string) => RemoteServerUpdaterSnapshot
  wait: (
    runtimeId: string,
    afterRevision: number,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<RemoteServerUpdaterWaitResult>
  check: (runtimeId: string, options?: UpdateCheckOptions) => RemoteServerUpdaterSnapshot
  download: (runtimeId: string) => RemoteServerUpdaterSnapshot
  install: (runtimeId: string) => RemoteServerUpdateInstallResult
}

const unavailableSnapshot = (runtimeId: string): RemoteServerUpdaterSnapshot => ({
  appVersion: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
  runtimeId,
  support: {
    installMode: 'unsupported-headless-serve',
    automatic: false,
    reason: 'updater-unavailable'
  },
  status: { state: 'idle' },
  revision: 0
})

let adapter: RemoteServerUpdaterAdapter = {
  getSnapshot: unavailableSnapshot,
  // Why: no updater to observe, so a wait immediately reports the (unchanging) snapshot as timed out.
  wait: (runtimeId) => Promise.resolve({ ...unavailableSnapshot(runtimeId), timedOut: true }),
  check: () => {
    throw new Error('remote_update_manual_required')
  },
  download: () => {
    throw new Error('remote_update_manual_required')
  },
  install: () => {
    throw new Error('remote_update_manual_required')
  }
}

export function configureRemoteServerUpdater(next: RemoteServerUpdaterAdapter): void {
  adapter = next
}

export function getRemoteServerUpdaterSnapshot(runtimeId: string): RemoteServerUpdaterSnapshot {
  return adapter.getSnapshot(runtimeId)
}

export function waitRemoteServerUpdater(
  runtimeId: string,
  afterRevision: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RemoteServerUpdaterWaitResult> {
  return adapter.wait(runtimeId, afterRevision, timeoutMs, signal)
}

export function checkRemoteServerUpdater(
  runtimeId: string,
  options?: UpdateCheckOptions
): RemoteServerUpdaterSnapshot {
  return options ? adapter.check(runtimeId, options) : adapter.check(runtimeId)
}

export function downloadRemoteServerUpdater(runtimeId: string): RemoteServerUpdaterSnapshot {
  return adapter.download(runtimeId)
}

export function installRemoteServerUpdater(runtimeId: string): RemoteServerUpdateInstallResult {
  return adapter.install(runtimeId)
}
