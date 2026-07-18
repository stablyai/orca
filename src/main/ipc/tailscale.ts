import { ipcMain } from 'electron'
import { discoverTailnetPeers } from '../network/tailscale-peer-discovery'

const TAILSCALE_IPC_CHANNELS = ['tailscale:discoverPeers'] as const

export function registerTailscaleHandlers(): void {
  // Why: macOS re-activation re-attaches window services, and ipcMain.handle()
  // throws if a handler is already registered.
  for (const channel of TAILSCALE_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle('tailscale:discoverPeers', () => discoverTailnetPeers())
}
