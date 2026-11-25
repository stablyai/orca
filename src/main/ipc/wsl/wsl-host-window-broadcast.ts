/** WSL host events main sends every window: host status, and capability changes mid-run. */
import { BrowserWindow } from 'electron'
import {
  WSL_HOST_ADD_PROGRESS_CHANNEL,
  WSL_HOST_CAPABILITY_CHANNEL,
  WSL_HOST_STATUS_CHANNEL,
  type WslHostCapability,
  type WslHostStatus
} from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { onWslHostsNewWorkChanged } from '../../wsl/host-lifecycle/wsl-host-gate'
import type { WslOrcadConnectionStatus } from '../../wsl/orcad/wsl-orcad-connection-status'
import { wslHostAddProgress } from '../../wsl/host-lifecycle/wsl-host-connection-record'

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      try {
        window.webContents.send(channel, payload)
      } catch {
        /* A renderer can close during publication. */
      }
    }
  }
}

export function publishWslHostStatus(status: WslHostStatus): void {
  broadcast(WSL_HOST_STATUS_CHANNEL, status)
}

// A dialog not adding the distro ignores these.
function publishWslHostAddProgress(distro: string, status: WslOrcadConnectionStatus): void {
  const progress = wslHostAddProgress(distro, status)
  if (progress) {
    broadcast(WSL_HOST_ADD_PROGRESS_CHANNEL, progress)
  }
}

export const wslHostWindowPublishers = {
  publish: publishWslHostStatus,
  publishAddProgress: publishWslHostAddProgress
}

let stopCapabilityPush: (() => void) | null = null

/** A block learned mid-run hides the offer and the add/move entry points without a relaunch. */
export function pushWslHostCapabilityOnNewWorkChange(capability: () => WslHostCapability): void {
  stopCapabilityPush?.()
  stopCapabilityPush = onWslHostsNewWorkChanged(() =>
    broadcast(WSL_HOST_CAPABILITY_CHANNEL, capability())
  )
}
