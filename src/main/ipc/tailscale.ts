import { ipcMain, shell } from 'electron'
import { getTailscaleSidecarClient } from '../tailscale/ts-sidecar-manager'
import type { TailscaleStatusResult } from '../../shared/tailscale-status'

// Why: surfaces tailnet status and interactive login to the renderer. Login opens
// the control-server auth URL in the user's browser; status reads the last known
// state without spawning the sidecar, so a badge never starts a tailnet node.
export function registerTailscaleHandlers(): void {
  ipcMain.handle('tailscale:status', (): TailscaleStatusResult => {
    const client = getTailscaleSidecarClient()
    if (!client) {
      return { available: false, status: null }
    }
    return { available: true, status: client.peekStatus() }
  })

  ipcMain.handle('tailscale:login', async (): Promise<TailscaleStatusResult> => {
    const client = getTailscaleSidecarClient()
    if (!client) {
      return { available: false, status: null }
    }
    const status = await client.login()
    if (status.authUrl) {
      await shell.openExternal(status.authUrl)
    }
    return { available: true, status }
  })
}
