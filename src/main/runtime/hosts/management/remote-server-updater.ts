import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../../../../shared/remote-runtime/host-catalog/remote-server-update'
import type { UpdateCheckOptions } from '../../../../shared/updater/update-status-types'

type MaybePromise<T> = T | Promise<T>

type RemoteServerUpdaterAdapter = {
  getSnapshot: (runtimeId: string) => MaybePromise<RemoteServerUpdaterSnapshot>
  check: (
    runtimeId: string,
    options?: UpdateCheckOptions
  ) => MaybePromise<RemoteServerUpdaterSnapshot>
  download: (runtimeId: string) => MaybePromise<RemoteServerUpdaterSnapshot>
  install: (runtimeId: string) => MaybePromise<RemoteServerUpdateInstallResult>
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

let configured = false
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
  configured = true
}

// Why: orcad never wires an updater, so it must not advertise updater.remote-control.v1.
export function isRemoteServerUpdaterConfigured(): boolean {
  return configured
}

export async function getRemoteServerUpdaterSnapshot(
  runtimeId: string
): Promise<RemoteServerUpdaterSnapshot> {
  return await adapter.getSnapshot(runtimeId)
}

export async function checkRemoteServerUpdater(
  runtimeId: string,
  options?: UpdateCheckOptions
): Promise<RemoteServerUpdaterSnapshot> {
  return options ? await adapter.check(runtimeId, options) : await adapter.check(runtimeId)
}

export async function downloadRemoteServerUpdater(
  runtimeId: string
): Promise<RemoteServerUpdaterSnapshot> {
  return await adapter.download(runtimeId)
}

export async function installRemoteServerUpdater(
  runtimeId: string
): Promise<RemoteServerUpdateInstallResult> {
  return await adapter.install(runtimeId)
}
