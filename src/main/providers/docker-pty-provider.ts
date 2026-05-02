import type { DockerEngineClientLike, DockerExecSession } from '../docker/docker-engine-client'
import { DockerEngineClient } from '../docker/docker-engine-client'
import type { DockerTarget } from '../docker/types'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types'

type DataCallback = (payload: { id: string; data: string }) => void
type ReplayCallback = (payload: { id: string; data: string }) => void
type ExitCallback = (payload: { id: string; code: number }) => void

export class DockerPtyProvider implements IPtyProvider {
  private target: DockerTarget
  private engine: DockerEngineClientLike
  private sessions = new Map<string, DockerExecSession>()
  private dataListeners = new Set<DataCallback>()
  private replayListeners = new Set<ReplayCallback>()
  private exitListeners = new Set<ExitCallback>()

  constructor(target: DockerTarget, engine: DockerEngineClientLike = new DockerEngineClient()) {
    this.target = target
    this.engine = engine
  }

  getConnectionId(): string {
    return this.target.containerId
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (opts.sessionId) {
      const existing = this.sessions.get(opts.sessionId)
      if (existing) {
        return {
          id: opts.sessionId,
          isReattach: true,
          replay: await existing.serialize()
        }
      }
    }

    const session = await this.engine.spawnExec({
      containerId: this.target.containerId,
      args: [opts.command ?? '/bin/sh'],
      cwd: opts.cwd ?? this.target.workdir,
      env: opts.env,
      tty: true,
      cols: opts.cols,
      rows: opts.rows
    })
    this.sessions.set(session.id, session)

    session.onData((data) => {
      for (const cb of this.dataListeners) {
        cb({ id: session.id, data })
      }
    })
    session.onReplay((data) => {
      for (const cb of this.replayListeners) {
        cb({ id: session.id, data })
      }
    })
    session.onExit((code) => {
      this.sessions.delete(session.id)
      for (const cb of this.exitListeners) {
        cb({ id: session.id, code })
      }
    })

    return {
      id: session.id,
      ...(opts.sessionId ? { sessionExpired: true } : {})
    }
  }

  async attach(id: string): Promise<void> {
    if (!this.sessions.has(id)) {
      throw new Error(`No Docker PTY session "${id}"`)
    }
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows)
  }

  async shutdown(id: string, immediate: boolean): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) {
      return
    }
    await session.shutdown(immediate)
    this.sessions.delete(id)
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    await this.sessions.get(id)?.sendSignal(signal)
  }

  async getCwd(id: string): Promise<string> {
    return (await this.sessions.get(id)?.getCwd()) ?? this.target.workdir
  }

  async getInitialCwd(id: string): Promise<string> {
    return (await this.sessions.get(id)?.getInitialCwd()) ?? this.target.workdir
  }

  async clearBuffer(id: string): Promise<void> {
    await this.sessions.get(id)?.clearBuffer()
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    this.sessions.get(id)?.acknowledgeDataEvent(charCount)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    return (await this.sessions.get(id)?.hasChildProcesses()) ?? false
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    return (await this.sessions.get(id)?.getForegroundProcess()) ?? null
  }

  async serialize(ids: string[]): Promise<string> {
    const entries = await Promise.all(
      ids.map(async (id) => [id, await this.sessions.get(id)?.serialize()] as const)
    )
    return JSON.stringify(Object.fromEntries(entries.filter(([, state]) => state !== undefined)))
  }

  async revive(state: string): Promise<void> {
    const parsed = JSON.parse(state) as Record<string, string>
    await Promise.all(
      Object.entries(parsed).map(async ([id, sessionState]) => {
        await this.sessions.get(id)?.revive(sessionState)
      })
    )
  }

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    return Promise.all(
      [...this.sessions.entries()].map(async ([id, session]) => ({
        id,
        cwd: await session.getCwd(),
        title: (await session.getForegroundProcess()) ?? 'shell'
      }))
    )
  }

  async getDefaultShell(): Promise<string> {
    return '/bin/sh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return [{ name: 'sh', path: '/bin/sh' }]
  }

  onData(callback: DataCallback): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: ReplayCallback): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(callback: ExitCallback): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }
}
