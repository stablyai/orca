import { createHash } from 'crypto'
import { join } from 'path'
import { PROTOCOL_VERSION } from './types'

export type DaemonConnectionInfo = {
  socketPath: string
  tokenPath: string
}

export type DaemonProcessHandle = {
  shutdown(): Promise<void>
}

export type DaemonLauncher = (socketPath: string, tokenPath: string) => Promise<DaemonProcessHandle>

export type DaemonSpawnerOptions = {
  runtimeDir: string
  launcher: DaemonLauncher
}

export class DaemonSpawner {
  private runtimeDir: string
  private launcher: DaemonLauncher
  private handle: DaemonProcessHandle | null = null
  private socketPath: string
  private tokenPath: string

  constructor(opts: DaemonSpawnerOptions) {
    this.runtimeDir = opts.runtimeDir
    this.launcher = opts.launcher
    this.socketPath = getDaemonSocketPath(this.runtimeDir)
    this.tokenPath = getDaemonTokenPath(this.runtimeDir)
  }

  async ensureRunning(): Promise<DaemonConnectionInfo> {
    if (this.handle) {
      return { socketPath: this.socketPath, tokenPath: this.tokenPath }
    }

    this.handle = await this.launcher(this.socketPath, this.tokenPath)

    return { socketPath: this.socketPath, tokenPath: this.tokenPath }
  }

  async shutdown(): Promise<void> {
    if (!this.handle) {
      return
    }
    const handle = this.handle
    this.handle = null
    await handle.shutdown()
  }
}

export function getDaemonSocketPath(runtimeDir: string): string {
  // Why: Windows IPC servers use named pipes rather than filesystem socket
  // files. Include the protocol version in the endpoint name so a daemon from
  // an older build is never reused after a breaking protocol change.
  if (process.platform === 'win32') {
    const suffix = createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)
    return `\\\\?\\pipe\\orca-terminal-host-v${PROTOCOL_VERSION}-${suffix}`
  }
  return join(runtimeDir, `daemon-v${PROTOCOL_VERSION}.sock`)
}

export function getDaemonTokenPath(runtimeDir: string): string {
  return join(runtimeDir, `daemon-v${PROTOCOL_VERSION}.token`)
}
