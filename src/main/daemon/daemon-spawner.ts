import { createHash } from 'crypto'
import { join } from 'path'
import { PROTOCOL_VERSION } from './types'

export type DaemonConnectionInfo = {
  socketPath: string
  tokenPath: string
}

export type DaemonPidFile = {
  pid: number
  startedAtMs: number | null
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

  // Why: after the daemon process dies unexpectedly, the cached handle is
  // stale. Clearing it lets the next ensureRunning() fork a fresh daemon
  // instead of returning the dead socket path.
  resetHandle(): void {
    this.handle = null
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

export function getDaemonSocketPath(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  // Why: Windows IPC servers use named pipes rather than filesystem socket
  // files. Include the protocol version in the endpoint name so a daemon from
  // an older build is never reused after a breaking protocol change.
  if (process.platform === 'win32') {
    const suffix = createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)
    return `\\\\?\\pipe\\orca-terminal-host-v${protocolVersion}-${suffix}`
  }
  return join(runtimeDir, `daemon-v${protocolVersion}.sock`)
}

export function getDaemonTokenPath(runtimeDir: string, protocolVersion = PROTOCOL_VERSION): string {
  return join(runtimeDir, `daemon-v${protocolVersion}.token`)
}

export function getDaemonPidPath(runtimeDir: string, protocolVersion = PROTOCOL_VERSION): string {
  return join(runtimeDir, `daemon-v${protocolVersion}.pid`)
}

export function serializeDaemonPidFile(pidFile: DaemonPidFile): string {
  return JSON.stringify(pidFile)
}
