import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { MobileReverseTunnelManager } from '../mobile-reverse-tunnel/mobile-reverse-tunnel-manager'
import { probeRemoteEndpoint } from '../mobile-reverse-tunnel/system-ssh-reverse-tunnel-process'
import type { MobileReverseTunnelStartArgs } from '../../shared/mobile-reverse-tunnel'

const MOBILE_TUNNEL_IPC_CHANNELS = [
  'mobileTunnel:list',
  'mobileTunnel:start',
  'mobileTunnel:stop',
  'mobileTunnel:testEndpoint'
] as const

let manager: MobileReverseTunnelManager | null = null

export function registerMobileReverseTunnelHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null
): MobileReverseTunnelManager {
  for (const channel of MOBILE_TUNNEL_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  const sshStore = new SshConnectionStore(store)
  manager ??= new MobileReverseTunnelManager({ getMainWindow })
  manager.setMainWindowGetter(getMainWindow)

  ipcMain.handle('mobileTunnel:list', () => ({ tunnels: manager!.listTunnels() }))

  ipcMain.handle('mobileTunnel:start', async (_event, args: MobileReverseTunnelStartArgs) => {
    const target = sshStore.getTarget(args.targetId)
    if (!target) {
      throw new Error(`SSH target "${args.targetId}" not found.`)
    }
    return manager!.startTunnel(args, target)
  })

  ipcMain.handle('mobileTunnel:stop', async (_event, args: { id: string }) => ({
    stopped: await manager!.stopTunnel(args.id)
  }))

  ipcMain.handle(
    'mobileTunnel:testEndpoint',
    async (_event, args: { host: string; port: number }) => {
      await probeRemoteEndpoint(args.host, args.port)
      return { reachable: true }
    }
  )

  return manager
}

export function resetMobileReverseTunnelHandlersForTests(): void {
  manager = null
}
