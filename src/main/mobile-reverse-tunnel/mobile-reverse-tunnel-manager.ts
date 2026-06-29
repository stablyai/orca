import type { BrowserWindow } from 'electron'
import type {
  MobileReverseTunnelEntry,
  MobileReverseTunnelStartArgs
} from '../../shared/mobile-reverse-tunnel'
import type { SshTarget } from '../../shared/ssh-types'
import {
  startSystemSshReverseTunnelProcess,
  type SystemSshReverseTunnelProcess
} from './system-ssh-reverse-tunnel-process'

type StartedMobileReverseTunnel = {
  entry: MobileReverseTunnelEntry
  process: SystemSshReverseTunnelProcess
}

type MobileReverseTunnelManagerOptions = {
  getMainWindow?: () => BrowserWindow | null
}

const DEFAULT_REMOTE_BIND_HOST = '0.0.0.0'
const DEFAULT_LOCAL_HOST = '127.0.0.1'

export class MobileReverseTunnelManager {
  private tunnels = new Map<string, StartedMobileReverseTunnel>()

  constructor(private options: MobileReverseTunnelManagerOptions = {}) {}

  setMainWindowGetter(getMainWindow: () => BrowserWindow | null): void {
    this.options.getMainWindow = getMainWindow
  }

  listTunnels(): MobileReverseTunnelEntry[] {
    return [...this.tunnels.values()].map(({ entry }) => entry)
  }

  async startTunnel(
    args: MobileReverseTunnelStartArgs,
    target: SshTarget
  ): Promise<MobileReverseTunnelEntry> {
    const publicHost = normalizeHost(args.publicHost)
    const remoteBindHost = normalizeHost(args.remoteBindHost ?? DEFAULT_REMOTE_BIND_HOST)
    const remotePort = normalizePort(args.remotePort, 'remotePort')
    const localPort = normalizePort(args.localPort, 'localPort')
    const existing = this.findTunnelForTarget(target.id)
    if (existing) {
      await this.stopTunnel(existing.entry.id)
    }

    const id = `mobile-tunnel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()
    const entry: MobileReverseTunnelEntry = {
      id,
      targetId: target.id,
      targetLabel: target.label,
      publicHost,
      remoteBindHost,
      remotePort,
      localHost: DEFAULT_LOCAL_HOST,
      localPort,
      advertisedAddress: formatAdvertisedAddress(publicHost, remotePort),
      status: 'starting',
      error: null,
      startedAt: now,
      updatedAt: now
    }
    const process = startSystemSshReverseTunnelProcess(target, {
      remoteBindHost,
      remotePort,
      localHost: DEFAULT_LOCAL_HOST,
      localPort,
      probeHost: publicHost
    })
    const started: StartedMobileReverseTunnel = { entry, process }
    this.tunnels.set(id, started)
    this.broadcast(entry)

    process.process.once('exit', () => {
      const current = this.tunnels.get(id)
      if (current !== started || current.entry.status === 'stopping') {
        return
      }
      current.entry = {
        ...current.entry,
        status: 'failed',
        error: 'SSH tunnel exited unexpectedly.',
        updatedAt: Date.now()
      }
      this.broadcast(current.entry)
    })

    try {
      await process.waitForStartup()
      const current = this.tunnels.get(id)
      if (!current) {
        return { ...entry, status: 'stopping', updatedAt: Date.now() }
      }
      current.entry = { ...current.entry, status: 'running', error: null, updatedAt: Date.now() }
      this.broadcast(current.entry)
      return current.entry
    } catch (error) {
      process.dispose()
      const current = this.tunnels.get(id)
      const failedEntry = {
        ...(current?.entry ?? entry),
        status: 'failed' as const,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now()
      }
      // Why: keep the failed entry visible so Settings can show the stderr
      // instead of collapsing back to an unexplained idle state.
      this.tunnels.set(id, { entry: failedEntry, process })
      this.broadcast(failedEntry)
      throw error
    }
  }

  async stopTunnel(id: string): Promise<boolean> {
    const current = this.tunnels.get(id)
    if (!current) {
      return false
    }
    current.entry = { ...current.entry, status: 'stopping', updatedAt: Date.now() }
    this.broadcast(current.entry)
    this.tunnels.delete(id)
    await current.process.close()
    return true
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.tunnels.keys()].map((id) => this.stopTunnel(id)))
  }

  private findTunnelForTarget(targetId: string): StartedMobileReverseTunnel | null {
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.entry.targetId === targetId) {
        return tunnel
      }
    }
    return null
  }

  private broadcast(entry: MobileReverseTunnelEntry): void {
    const win = this.options.getMainWindow?.()
    if (!win || win.isDestroyed()) {
      return
    }
    win.webContents.send('mobileTunnel:changed', entry)
  }
}

export function formatAdvertisedAddress(publicHost: string, remotePort: number): string {
  const host =
    publicHost.includes(':') && !publicHost.startsWith('[') ? `[${publicHost}]` : publicHost
  return `${host}:${remotePort}`
}

function normalizeHost(value: string): string {
  const host = value.trim()
  if (!host) {
    throw new Error('Host is required.')
  }
  return host
}

function normalizePort(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${field} must be a port between 1 and 65535.`)
  }
  return value
}
