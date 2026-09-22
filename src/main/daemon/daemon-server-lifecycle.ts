import { createServer, type Server, type Socket } from 'node:net'
import type { DaemonEndpointLifecycle } from './daemon-endpoint-lifecycle'
import type { DaemonFileLog } from './daemon-file-log'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from './types'

type PendingShutdownReply = { start: () => void }

type DaemonServerLifecycleOptions = {
  protocolVersion: number
  initialAdoptionTimeoutMs: number
  clock: {
    setTimeout(callback: () => void, delayMs: number): unknown
    clearTimeout(handle: unknown): void
    now(): number
  }
  endpoint: DaemonEndpointLifecycle
  log: DaemonFileLog
  isIdle: () => boolean
  disposeResources: () => Promise<void>
  onIdleShutdown: () => void
  onRpcShutdown: () => void
}

export class DaemonServerLifecycle {
  private static readonly SHUTDOWN_REPLY_FLUSH_TIMEOUT_MS = 1_000
  private server: Server | null = null
  private startupFailure: Error | null = null
  private state: 'running' | 'idle-shutdown-pending' | 'shutting-down' = 'running'
  private initialAdoptionTimer: unknown = null
  private initialAdoptionDeadlineMs: number | null = null
  private retirementRequested = false
  private shutdownPromise: Promise<void> | null = null
  private ordinaryShutdownServerClose: Promise<void> | null = null
  private readonly pendingShutdownReplies = new Map<string, PendingShutdownReply>()

  constructor(private readonly options: DaemonServerLifecycleOptions) {}

  isAcceptingWork(): boolean {
    return this.state === 'running'
  }

  async start(handleConnection: (socket: Socket) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(handleConnection)
      let startupSettled = false
      const onServerError = (error: Error): void => {
        if (startupSettled) {
          this.options.log.log('server-error', { message: error.message })
          console.warn(`[daemon] Socket server error: ${error.message}`)
          return
        }
        startupSettled = true
        this.startupFailure = error
        reject(error)
      }
      this.server.on('error', onServerError)
      const bindPath = this.options.endpoint.bindPath()
      this.server.listen(bindPath, () => {
        this.options.endpoint.secureBindPath(bindPath)
        const abandonStartup = (error: unknown): void => {
          startupSettled = true
          const server = this.server
          this.server = null
          reject(error)
          server?.close()
          this.options.endpoint.abandonBindPath(bindPath)
        }
        void this.options.endpoint.publish(bindPath).then(() => {
          if (this.startupFailure) {
            this.options.endpoint.retireUnstarted()
            this.cancelInitialAdoptionTimer()
            abandonStartup(this.startupFailure)
            return
          }
          if (this.options.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
            this.armInitialAdoptionTimeout()
          }
          this.options.endpoint.startOwnershipWatch()
          startupSettled = true
          resolve()
        }, abandonStartup)
      })
    })
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      const serverClose = this.beginOrdinaryShutdownFence()
      this.shutdownPromise = this.finishOrdinaryShutdown(serverClose)
    }
    return this.shutdownPromise
  }

  onConnectionAccepted(): void {
    this.cancelInitialAdoptionTimer()
  }

  onAuthenticatedPair(): void {
    this.initialAdoptionDeadlineMs = null
    this.cancelInitialAdoptionTimer()
    if (!this.options.endpoint.lost) {
      this.retirementRequested = false
    }
  }

  onLastAuthenticatedClientDisconnected(): void {
    if (this.state === 'running') {
      this.retirementRequested = true
    }
  }

  onEndpointOwnershipLost(): void {
    this.retirementRequested = true
    this.reevaluateIdleShutdown()
  }

  reevaluateIdleShutdown(): void {
    if (this.state !== 'running') {
      return
    }
    if (this.retirementRequested) {
      this.cancelInitialAdoptionTimer()
      if (this.options.isIdle()) {
        this.beginIdleShutdown()
      }
      return
    }
    if (!this.options.isIdle() || this.initialAdoptionDeadlineMs === null) {
      this.cancelInitialAdoptionTimer()
      return
    }
    if (this.initialAdoptionTimer !== null) {
      return
    }
    const remainingMs = Math.max(0, this.initialAdoptionDeadlineMs - this.options.clock.now())
    if (remainingMs === 0) {
      this.initialAdoptionDeadlineMs = null
      this.retirementRequested = true
      this.beginIdleShutdown()
      return
    }
    this.initialAdoptionTimer = this.options.clock.setTimeout(() => {
      this.initialAdoptionTimer = null
      this.initialAdoptionDeadlineMs = null
      this.retirementRequested = true
      this.beginIdleShutdown()
    }, remainingMs)
  }

  beginOrdinaryShutdownFence(): Promise<void> {
    this.state = 'shutting-down'
    this.cancelInitialAdoptionTimer()
    this.ordinaryShutdownServerClose ??= this.beginServerClose()
    return this.ordinaryShutdownServerClose
  }

  deferRpcShutdownUntilReply(
    clientId: string,
    requestId: string,
    socket: Socket,
    serverClose: Promise<void>
  ): void {
    this.deferShutdownUntilReply(clientId, requestId, socket, () =>
      this.finishRpcShutdown(serverClose)
    )
  }
  finishRpcShutdownWithoutReply(serverClose: Promise<void>): void {
    this.shutdownPromise ??= this.finishRpcShutdown(serverClose)
  }

  retireAfterIdleReply(clientId: string, requestId: string, socket: Socket): void {
    this.state = 'shutting-down'
    this.initialAdoptionDeadlineMs = null
    this.retirementRequested = false
    this.cancelInitialAdoptionTimer()
    const serverClose = this.beginServerClose()
    this.deferShutdownUntilReply(clientId, requestId, socket, () =>
      this.finishIdleShutdown(serverClose)
    )
  }

  startPendingShutdownReply(clientId: string, requestId: string): void {
    this.pendingShutdownReplies.get(this.shutdownReplyKey(clientId, requestId))?.start()
  }

  private armInitialAdoptionTimeout(): void {
    this.initialAdoptionDeadlineMs =
      this.options.clock.now() + this.options.initialAdoptionTimeoutMs
    this.reevaluateIdleShutdown()
  }

  private cancelInitialAdoptionTimer(): void {
    if (this.initialAdoptionTimer === null) {
      return
    }
    this.options.clock.clearTimeout(this.initialAdoptionTimer)
    this.initialAdoptionTimer = null
  }

  private beginIdleShutdown(): void {
    this.initialAdoptionTimer = null
    if (this.state !== 'running') {
      return
    }
    this.state = 'idle-shutdown-pending'
    if (!this.options.isIdle()) {
      this.state = 'running'
      this.reevaluateIdleShutdown()
      return
    }
    this.state = 'shutting-down'
    const serverClose = this.beginServerClose()
    this.shutdownPromise = this.finishIdleShutdown(serverClose)
  }

  private async finishOrdinaryShutdown(serverClose: Promise<void>): Promise<void> {
    this.options.endpoint.unlinkOwnedArtifacts()
    await this.disposeResources()
    await serverClose
  }

  private async finishRpcShutdown(serverClose: Promise<void>): Promise<void> {
    await this.finishOrdinaryShutdown(serverClose)
    this.options.onRpcShutdown()
  }

  private async finishIdleShutdown(serverClose: Promise<void>): Promise<void> {
    this.options.endpoint.unlinkOwnedArtifacts()
    await this.disposeResources()
    await serverClose
    this.options.onIdleShutdown()
  }

  private async disposeResources(): Promise<void> {
    await this.options.disposeResources()
    this.pendingShutdownReplies.clear()
  }

  private beginServerClose(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private deferShutdownUntilReply(
    clientId: string,
    requestId: string,
    socket: Socket,
    finish: () => Promise<void>
  ): void {
    const key = this.shutdownReplyKey(clientId, requestId)
    let started = false
    let timer: ReturnType<typeof setTimeout>
    const start = (): void => {
      if (started) {
        return
      }
      started = true
      clearTimeout(timer)
      socket.off('close', start)
      socket.off('error', start)
      this.pendingShutdownReplies.delete(key)
      this.shutdownPromise ??= finish()
    }
    timer = setTimeout(start, DaemonServerLifecycle.SHUTDOWN_REPLY_FLUSH_TIMEOUT_MS)
    timer.unref()
    socket.once('close', start)
    socket.once('error', start)
    this.pendingShutdownReplies.set(key, { start })
  }

  private shutdownReplyKey(clientId: string, requestId: string): string {
    return `${clientId}\u0000${requestId}`
  }
}
