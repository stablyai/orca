import type {
  DockerBuildImageOptions,
  DockerCreateContainerOptions,
  DockerEngineClientLike,
  DockerExecOptions,
  DockerExecResult,
  DockerExecSession,
  DockerExecSessionOptions
} from './docker-engine-client'

export type DockerEngineFakeCommand =
  | { command: 'image.pull'; image: string }
  | { command: 'image.build'; options: DockerBuildImageOptions }
  | { command: 'container.create'; options: DockerCreateContainerOptions }
  | { command: 'container.start'; id: string }
  | { command: 'container.inspect'; id: string }
  | { command: 'container.exec'; options: DockerExecOptions }
  | { command: 'container.exec.spawn'; options: DockerExecSessionOptions }
  | { command: 'container.stop'; id: string }
  | { command: 'container.rm'; id: string }

type FakeContainer = {
  id: string
  imageId: string
  running: boolean
}

export class DockerEngineFake implements DockerEngineClientLike {
  readonly commands: DockerEngineFakeCommand[] = []
  readonly containers = new Map<string, FakeContainer>()
  readonly sessions = new Map<string, FakeDockerExecSession>()
  buildDelayMs = 0
  nextBuildError: Error | null = null
  nextExecError: Error | null = null
  private imageCounter = 0
  private containerCounter = 0
  private sessionCounter = 0
  private execResults: DockerExecResult[] = []

  enqueueExecResult(result: Partial<DockerExecResult> & { stdout?: string }): void {
    this.execResults.push({
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0
    })
  }

  async buildImage(options: DockerBuildImageOptions): Promise<{ imageId: string }> {
    this.commands.push({ command: 'image.build', options })
    if (this.nextBuildError) {
      const error = this.nextBuildError
      this.nextBuildError = null
      throw error
    }
    if (this.buildDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.buildDelayMs))
    }
    this.imageCounter += 1
    return { imageId: `sha256:fake-image-${this.imageCounter}` }
  }

  async pullImage(image: string): Promise<void> {
    this.commands.push({ command: 'image.pull', image })
  }

  async createContainer(options: DockerCreateContainerOptions): Promise<{ id: string }> {
    this.commands.push({ command: 'container.create', options })
    this.containerCounter += 1
    const id = `container-${this.containerCounter}`
    this.containers.set(id, { id, imageId: options.imageId, running: false })
    return { id }
  }

  async startContainer(id: string): Promise<void> {
    this.commands.push({ command: 'container.start', id })
    const container = this.containers.get(id)
    if (!container) {
      throw new Error(`Unknown container ${id}`)
    }
    container.running = true
  }

  async inspectContainer(id: string): Promise<{ id: string; imageId: string; running: boolean }> {
    this.commands.push({ command: 'container.inspect', id })
    const container = this.containers.get(id)
    if (!container) {
      throw new Error(`Unknown container ${id}`)
    }
    return { ...container }
  }

  async exec(options: DockerExecOptions): Promise<DockerExecResult> {
    this.commands.push({ command: 'container.exec', options })
    if (this.nextExecError) {
      const error = this.nextExecError
      this.nextExecError = null
      throw error
    }
    return this.execResults.shift() ?? { stdout: '', stderr: '', exitCode: 0 }
  }

  async spawnExec(options: DockerExecSessionOptions): Promise<DockerExecSession> {
    this.commands.push({ command: 'container.exec.spawn', options })
    this.sessionCounter += 1
    const session = new FakeDockerExecSession(`session-${this.sessionCounter}`, options.cwd)
    this.sessions.set(session.id, session)
    return session
  }

  async stopContainer(id: string): Promise<void> {
    this.commands.push({ command: 'container.stop', id })
    const container = this.containers.get(id)
    if (container) {
      container.running = false
    }
  }

  async removeContainer(id: string): Promise<void> {
    this.commands.push({ command: 'container.rm', id })
    this.containers.delete(id)
  }
}

export class FakeDockerExecSession implements DockerExecSession {
  readonly id: string
  readonly writes: string[] = []
  readonly resizes: { cols: number; rows: number }[] = []
  private cwd: string
  private initialCwd: string
  private buffer = ''
  private dataListeners = new Set<(data: string) => void>()
  private replayListeners = new Set<(data: string) => void>()
  private exitListeners = new Set<(code: number) => void>()
  private exited = false

  constructor(id: string, cwd: string) {
    this.id = id
    this.cwd = cwd
    this.initialCwd = cwd
  }

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }

  async shutdown(_immediate: boolean): Promise<void> {
    this.crash(0)
  }

  async sendSignal(_signal: string): Promise<void> {}

  async getCwd(): Promise<string> {
    return this.cwd
  }

  async getInitialCwd(): Promise<string> {
    return this.initialCwd
  }

  async clearBuffer(): Promise<void> {
    this.buffer = ''
  }

  acknowledgeDataEvent(_charCount: number): void {}

  async hasChildProcesses(): Promise<boolean> {
    return !this.exited
  }

  async getForegroundProcess(): Promise<string | null> {
    return this.exited ? null : 'sh'
  }

  async serialize(): Promise<string> {
    return this.buffer
  }

  async revive(state: string): Promise<void> {
    this.buffer = state
    for (const cb of this.replayListeners) {
      cb(state)
    }
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: (data: string) => void): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(callback: (code: number) => void): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  emitData(data: string): void {
    this.buffer += data
    for (const cb of this.dataListeners) {
      cb(data)
    }
  }

  crash(code: number): void {
    if (this.exited) {
      return
    }
    this.exited = true
    for (const cb of this.exitListeners) {
      cb(code)
    }
  }
}
