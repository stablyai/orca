import { ipcMain } from 'electron'
import { discoverTailnetPeers } from '../network/tailscale-peer-discovery'

const TAILSCALE_IPC_CHANNELS = ['tailscale:discoverPeers'] as const

/**
 * Registers the `tailscale:discoverPeers` IPC handler, replacing any existing
 * registration so repeated window re-attachment on macOS stays idempotent.
 */
export function registerTailscaleHandlers(): void {
  // Why: macOS re-activation re-attaches window services, and ipcMain.handle()
  // throws if a handler is already registered.
  for (const channel of TAILSCALE_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle('tailscale:discoverPeers', () => discoverTailnetPeers())
}
