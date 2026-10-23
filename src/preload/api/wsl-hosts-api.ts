/**
 * WSL distros as hosts; desktop-only and Windows-only (or the e2e fake) behind the internal gate,
 * else undefined.
 */
import { ipcRenderer } from 'electron'
import {
  WSL_HOST_STATUS_CHANNEL,
  type WslHostAddResult,
  type WslHostCapability,
  type WslHostDistro,
  type WslHostServerStop,
  type WslHostStatus
} from '../../shared/wsl-host-types'
import { isWslHostsInternalGateOpen } from '../../shared/wsl-host-internal-gate'

export type WslHostsPreloadApi = {
  getCapability: () => Promise<WslHostCapability>
  listDistros: () => Promise<WslHostDistro[]>
  add: (args: { distro: string; startIfStopped?: boolean }) => Promise<WslHostAddResult>
  remove: (args: { environmentId: string }) => Promise<WslHostServerStop>
  /** `force` takes an update that live terminals deferred. */
  connect: (args: { environmentId: string; force?: boolean }) => Promise<void>
  getStatuses: () => Promise<WslHostStatus[]>
  onStatusChanged: (callback: (status: WslHostStatus) => void) => () => void
  /** The WSL hosts an open project or terminal needs; only these may boot a stopped distro. */
  setVisibleWork: (args: { environmentIds: string[] }) => Promise<void>
}

const wslHostsApi: WslHostsPreloadApi = {
  getCapability: () => ipcRenderer.invoke('wslHosts:getCapability'),
  listDistros: () => ipcRenderer.invoke('wslHosts:listDistros'),
  add: (args) => ipcRenderer.invoke('wslHosts:add', args),
  remove: (args) => ipcRenderer.invoke('wslHosts:remove', args),
  connect: (args) => ipcRenderer.invoke('wslHosts:connect', args),
  getStatuses: () => ipcRenderer.invoke('wslHosts:getStatuses'),
  onStatusChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: WslHostStatus): void =>
      callback(status)
    ipcRenderer.on(WSL_HOST_STATUS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(WSL_HOST_STATUS_CHANNEL, listener)
  },
  setVisibleWork: (args) => ipcRenderer.invoke('wslHosts:setVisibleWork', args)
}

/** Undefined hides every WSL host surface in the renderer; main refuses the calls regardless. */
export function getWslHostsApi(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): WslHostsPreloadApi | undefined {
  if (!isWslHostsInternalGateOpen(env)) {
    return undefined
  }
  return platform === 'win32' || env.ORCA_E2E_FAKE_WSL_HOSTS ? wslHostsApi : undefined
}
