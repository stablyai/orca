import type { ProviderProcessCloseResult } from '../../../provider-process/provider-process-close'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import {
  codexOpenedThreadId,
  codexSharedFrameParams,
  codexTurnId,
  type CodexSharedServerFrame
} from './codex-shared-server-frames'

/** A paused chat holds its own frames; past these it is dropped instead of stalling the server. */
export const CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES = 20_000
export const CODEX_SHARED_LEASE_MAX_QUEUED_BYTES = 64 * 1024 * 1024

const OPENS_THREAD = new Set(['thread/start', 'thread/resume', 'thread/fork'])

/** What a lease needs from the server it rides on. */
export type CodexSharedLeaseHost = {
  readonly pid: number | undefined
  readonly closed: boolean
  readonly connection: CodexAppServerConnection
  claim: (threadId: string, lease: CodexSharedServerLease) => void
  /** Records a turn/start in flight, so a release that races it still interrupts its turn. */
  trackTurnStart: (threadId: string, request: Promise<unknown>) => void
  noteTurnStarted: (threadId: string, turnId: string) => void
  /** True only once every turn this chat ran is proven over. */
  release: (lease: CodexSharedServerLease) => Promise<boolean>
}

/** One chat's view of a shared app-server: its threads' frames, its own backpressure and close. */
export class CodexSharedServerLease implements CodexAppServerConnection {
  readonly threads = new Set<string>()
  closeResult: ProviderProcessCloseResult | null = null
  private state: 'open' | 'closing' | 'ended' = 'open'
  private closing: Promise<boolean> | null = null
  private closeAnnounced = false
  private paused = false
  private draining = false
  private queue: { frame: CodexSharedServerFrame; bytes: number }[] = []
  /** Next frame to dispatch; drained slots are dropped in one splice so a drain stays linear. */
  private queueHead = 0
  private queuedBytes = 0

  constructor(
    private readonly host: CodexSharedLeaseHost,
    private readonly handlers: CodexAppServerConnectionHandlers,
    readonly sessionId: string | null
  ) {}

  get pid(): number | undefined {
    return this.host.pid
  }

  get closed(): boolean {
    return this.state !== 'open' || this.host.closed
  }

  get open(): boolean {
    return this.state === 'open'
  }

  /** The lease ended without proof that its turns stopped (Stop reports it, as for a live tree). */
  get processTreeUnproven(): boolean {
    return this.closeResult !== null && this.closeResult.tree !== 'exited'
  }

  request(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number | null; onReply?: (result?: unknown) => void } = {}
  ): Promise<unknown> {
    if (this.state !== 'open') {
      return Promise.reject(new Error(`codex app-server connection is closed (${method})`))
    }
    // The server was initialized once when it started; Codex refuses a second initialize.
    if (method === 'initialize') {
      return Promise.resolve({})
    }
    if (method === 'thread/resume' && typeof params?.threadId === 'string') {
      this.host.claim(params.threadId, this)
    }
    const opensThread = OPENS_THREAD.has(method)
    const turnThreadId =
      method === 'turn/start' && typeof params?.threadId === 'string' ? params.threadId : null
    const request = this.host.connection.request(method, params, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      // Claimed before the reply's continuation, so frames Codex sent first reach this chat first.
      onReply: (result) => {
        const threadId = opensThread ? codexOpenedThreadId(result) : null
        if (threadId && this.state === 'open') {
          this.host.claim(threadId, this)
        }
        const turnId = turnThreadId ? codexTurnId(result) : null
        if (turnThreadId && turnId) {
          this.host.noteTurnStarted(turnThreadId, turnId)
        }
        options.onReply?.(result)
      }
    })
    if (turnThreadId) {
      this.host.trackTurnStart(turnThreadId, request)
    }
    return request
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.state !== 'open' || method === 'initialized') {
      return
    }
    this.host.connection.notify(method, params)
  }

  respond(id: number | string, result: unknown): void {
    if (this.state === 'open') {
      this.host.connection.respond(id, result)
    }
  }

  respondWithError(id: number | string, code: number, message: string): void {
    if (this.state === 'open') {
      this.host.connection.respondWithError(id, code, message)
    }
  }

  pauseReading = (): void => {
    this.paused = true
  }

  resumeReading = (): void => {
    this.paused = false
    this.drainQueue()
  }

  deliver(frame: CodexSharedServerFrame): void {
    if (this.state === 'ended') {
      return
    }
    if (this.paused || this.queue.length > this.queueHead) {
      const bytes = Buffer.byteLength(JSON.stringify(codexSharedFrameParams(frame) ?? null), 'utf8')
      this.queue.push({ frame, bytes })
      this.queuedBytes += bytes
      if (
        this.queue.length - this.queueHead > CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES ||
        this.queuedBytes > CODEX_SHARED_LEASE_MAX_QUEUED_BYTES
      ) {
        this.fail(new Error('codex chat fell too far behind its shared app-server'), true)
      }
      return
    }
    this.dispatch(frame)
  }

  private drainQueue(): void {
    if (this.draining) {
      return
    }
    this.draining = true
    try {
      while (!this.paused && this.queueHead < this.queue.length && this.state !== 'ended') {
        const { frame, bytes } = this.queue[this.queueHead]!
        this.queueHead += 1
        this.queuedBytes -= bytes
        this.dispatch(frame)
      }
    } finally {
      this.queue.splice(0, this.queueHead)
      this.queueHead = 0
      this.draining = false
    }
  }

  private dispatch(frame: CodexSharedServerFrame): void {
    try {
      if (frame.kind === 'request') {
        this.handlers.onServerRequest?.(frame.request)
        return
      }
      this.handlers.onNotification?.(frame.method, frame.params)
    } catch (error) {
      // One chat's handler failing must not reach the shared reader and end every chat.
      this.fail(error instanceof Error ? error : new Error(String(error)), true)
    }
  }

  /** The server is up and this chat may use it; a rejection from onSpawned ends the lease. */
  async announce(): Promise<void> {
    const pid = this.host.pid
    if (pid !== undefined) {
      await this.handlers.onSpawned?.(pid)
    }
  }

  close(): Promise<boolean> {
    if (this.state === 'ended') {
      return Promise.resolve(true)
    }
    if (this.closing) {
      return this.closing
    }
    this.state = 'closing'
    const error = new Error('codex app-server connection closed')
    this.announceClose(error)
    this.closing = this.host
      .release(this)
      .catch(() => false)
      .then((proven) => {
        this.finish(error, true, proven)
        return true
      })
    return this.closing
  }

  /** The server can take no more requests; its exit, reported to every chat, follows. */
  serverClosing(error: Error): void {
    this.announceClose(error)
  }

  private announceClose(error: Error): void {
    if (!this.closeAnnounced) {
      this.closeAnnounced = true
      this.handlers.onClose?.(error)
    }
  }

  /** Ends this chat's lease alone: the server died, or this chat can no longer keep up. */
  fail(error: Error, releaseOnServer: boolean): void {
    if (this.state === 'ended') {
      return
    }
    if (this.state === 'closing') {
      // A dead server proves its turns ended; anything else leaves the close's own proof pending.
      if (!releaseOnServer) {
        this.finish(error, true, true)
      }
      return
    }
    this.state = 'closing'
    this.announceClose(error)
    this.paused = true
    if (!releaseOnServer) {
      this.finish(error, false, true)
      return
    }
    // The chat hears its exit only after its turns are stopped, so a recovery can't race them; a
    // close meanwhile waits on this same cleanup.
    this.closing = this.host
      .release(this)
      .catch(() => false)
      .then((proven) => {
        this.finish(error, false, proven)
        return true
      })
  }

  private finish(error: Error, expected: boolean, proven: boolean): void {
    if (this.state === 'ended') {
      return
    }
    this.state = 'ended'
    this.queue = []
    this.queueHead = 0
    this.queuedBytes = 0
    this.closeResult = { root: 'exited', tree: proven ? 'exited' : 'live' }
    this.handlers.onExit?.(error, { expected })
  }
}
