import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../../shared/remote-server-update'
import type { UpdateCheckOptions } from '../../shared/types'

type RemoteServerUpdaterAdapter = {
  getSnapshot: (runtimeId: string) => RemoteServerUpdaterSnapshot
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
  status: { state: 'idle' }
})

let adapter: RemoteServerUpdaterAdapter = {
  getSnapshot: unavailableSnapshot,
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
