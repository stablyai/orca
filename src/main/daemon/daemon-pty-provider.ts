import { DaemonClient } from './client'
import type { DaemonEvent, CreateOrAttachResult } from './types'

export type DaemonPtyProviderOptions = {
  socketPath: string
  tokenPath: string
}

export type DaemonSpawnOptions = {
  cols: number
  rows: number
  sessionId: string
  cwd?: string
  env?: Record<string, string>
  command?: string
}

export type DaemonSpawnResult = {
  id: string
  isNew: boolean
  pid: number | null
}

export class DaemonPtyProvider {
  private client: DaemonClient
  private dataListeners: ((payload: { id: string; data: string }) => void)[] = []
  private exitListeners: ((payload: { id: string; code: number }) => void)[] = []
  private removeEventListener: (() => void) | null = null

  constructor(opts: DaemonPtyProviderOptions) {
    this.client = new DaemonClient({
      socketPath: opts.socketPath,
      tokenPath: opts.tokenPath
    })
  }

  async spawn(opts: DaemonSpawnOptions): Promise<DaemonSpawnResult> {
    await this.client.ensureConnected()
    this.setupEventRouting()

    const result = await this.client.request<CreateOrAttachResult>('createOrAttach', {
      sessionId: opts.sessionId,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
      command: opts.command
    })

    return {
      id: opts.sessionId,
      isNew: result.isNew,
      pid: result.pid
    }
  }

  write(id: string, data: string): void {
    this.client.notify('write', { sessionId: id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.client.notify('resize', { sessionId: id, cols, rows })
  }

  async shutdown(id: string, _immediate: boolean): Promise<void> {
    await this.client.request('kill', { sessionId: id })
  }

  onData(callback: (payload: { id: string; data: string }) => void): () => void {
    this.dataListeners.push(callback)
    return () => {
      const idx = this.dataListeners.indexOf(callback)
      if (idx !== -1) {
        this.dataListeners.splice(idx, 1)
      }
    }
  }

  onExit(callback: (payload: { id: string; code: number }) => void): () => void {
    this.exitListeners.push(callback)
    return () => {
      const idx = this.exitListeners.indexOf(callback)
      if (idx !== -1) {
        this.exitListeners.splice(idx, 1)
      }
    }
  }

  async cleanup(): Promise<void> {
    this.removeEventListener?.()
    this.removeEventListener = null
    this.client.disconnect()
  }

  private setupEventRouting(): void {
    if (this.removeEventListener) {
      return
    }

    this.removeEventListener = this.client.onEvent((raw) => {
      const event = raw as DaemonEvent
      if (event.type !== 'event') {
        return
      }

      if (event.event === 'data') {
        for (const listener of this.dataListeners) {
          listener({ id: event.sessionId, data: event.payload.data })
        }
      } else if (event.event === 'exit') {
        for (const listener of this.exitListeners) {
          listener({ id: event.sessionId, code: event.payload.code })
        }
      }
    })
  }
}
