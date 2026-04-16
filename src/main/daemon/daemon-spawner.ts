import { join } from 'path'

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
    this.socketPath = join(this.runtimeDir, 'daemon.sock')
    this.tokenPath = join(this.runtimeDir, 'daemon.token')
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
