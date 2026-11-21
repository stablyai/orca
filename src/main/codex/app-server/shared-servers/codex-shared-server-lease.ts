import { randomUUID } from 'node:crypto'
import type { ProviderProcessCloseResult } from '../../../provider-process/provider-process-close'
import type { DescendantTreeVerdict } from '../../../pty/process-retirement/pty-descendant-exit-verification'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import { codexSharedFrameParams, type CodexSharedServerFrame } from './codex-shared-server-frames'
import type { CodexSharedServerRouter } from './codex-shared-server-router'
import { sendCodexLeaseRequest } from './codex-shared-server-lease-requests'

/** A paused chat holds its own frames; past this it is dropped instead of stalling the server.
 *  Bytes are bounded per server (codex-shared-server-backlog.ts). */
export const CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES = 20_000

/** A release's outcome: whether the chat's turns are proven over (else it stays on the server for
 *  a retry), and whether its commands are proven gone. */
export type CodexLeaseRelease = { writerStopped: boolean; workloadGone: boolean }

/** A paused chat that resumes replays this much of its queue per task, then yields, as a pipe
 *  read would. */
const DRAIN_CHUNK_BYTES = 64 * 1024

/** What a lease needs from the server it rides on. */
export type CodexSharedLeaseHost = {
  readonly pid: number | undefined
  readonly closed: boolean
  readonly connection: CodexAppServerConnection
  claim: (threadId: string, lease: CodexSharedServerLease) => void
  /** This chat's queue grew or shrank by these bytes, or it may have started waiting (0). */
  backlog: (lease: CodexSharedServerLease, deltaBytes: number) => void
  /** Whether any of these threads has a turn running. */
  hasRunningTurn: (threads: Iterable<string>) => boolean
  /** A thread open or turn start settled, so a wait on them can re-check. */
  turnsChanged: () => void
  /** Settles once a retried release could prove more: a turn ended, another chat left, or the
   *  server exited. */
  releaseMayProve: (lease: CodexSharedServerLease) => Promise<unknown>
  readonly router: Pick<CodexSharedServerRouter, 'heldByOther' | 'unclaim' | 'openSettled'>
  /** A thread that opened after its chat left: nobody will use it, so the server lets it go.
   *  Resolves whether Codex confirmed it. */
  abandon: (threadId: string, lease: CodexSharedServerLease) => Promise<boolean>
  /** Settles once no chat leaving the server is still cleaning up this thread. */
  threadReleased: (threadId: string) => Promise<void>
  /** Records a turn/start in flight, so a release that races it still interrupts its turn. */
  trackTurnStart: (threadId: string, request: Promise<unknown>) => void
  noteTurnStarted: (threadId: string, turnId: string) => void
  release: (lease: CodexSharedServerLease) => Promise<CodexLeaseRelease>
  /** After the server exited: whether its commands were proven gone, once reaped. */
  workloadVerdict: () => DescendantTreeVerdict
  afterReap: () => Promise<void>
}

/** One chat's view of a shared app-server: its threads' frames, its own backpressure and close. */
export class CodexSharedServerLease implements CodexAppServerConnection {
  readonly threads = new Set<string>()
  /** Tags every command this chat's threads run (CODEX_SHARED_LEASE_ENV). */
  readonly id = randomUUID()
  /** thread/start, /resume and /fork still awaiting Codex; close waits for them. */
  readonly pendingOpens = new Set<Promise<unknown>>()
  readonly outstanding = new Set<(error: Error) => void>()
  /** Threads that opened after this chat left, and the server letting each go. */
  readonly abandonedThreads = new Set<string>()
  readonly abandoning = new Set<Promise<boolean>>()
  private workload: (() => DescendantTreeVerdict) | null = null
  private state: 'open' | 'closing' | 'ended' = 'open'
  private closing: Promise<boolean> | null = null
  private closeAnnounced = false
  private paused = false
  private draining = false
  private queue: { frame: CodexSharedServerFrame; bytes: number }[] = []
  /** Next frame to dispatch; drained slots are dropped in one splice so a drain stays linear. */
  private queueHead = 0
  private queuedBytes = 0
  /** Dropped for falling behind: its frames are discarded until it ends. */
  private shedding = false
  /** Its cleanup is running and needs the shared reader. */
  private releasing = false
  private drainScheduled = false

  constructor(
    readonly host: CodexSharedLeaseHost,
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

  /** Still owns its threads' frames, including while a close waits for its turns to stop. */
  get routable(): boolean {
    return this.state !== 'ended'
  }

  /** The lease's end, judged like a process: the chat's commands are its workload tree. */
  get closeResult(): ProviderProcessCloseResult | null {
    return this.workload ? { root: 'exited', tree: this.workload() } : null
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
    return sendCodexLeaseRequest(this, method, params, options)
  }

  claim = (threadId: string): void => this.host.claim(threadId, this)
  heldByOther = (threadId: string): boolean => this.host.router.heldByOther(threadId, this)
  unclaim = (threadId: string): void => this.host.router.unclaim(threadId, this)

  abandon(threadId: string): void {
    void this.host.abandon(threadId, this)
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
    this.noteWaiting()
  }

  /** Reading and owed frames: a paused shared reader would stall this chat. */
  get waiting(): boolean {
    return (
      this.releasing ||
      (this.state === 'open' &&
        !this.paused &&
        // One still catching up on its own queue waits on itself, not on the others.
        this.queuedBytes === 0 &&
        (this.outstanding.size > 0 || this.host.hasRunningTurn(this.threads)))
    )
  }

  noteWaiting(): void {
    this.host.backlog(this, 0)
  }

  deliver(frame: CodexSharedServerFrame): void {
    if (this.state === 'ended' || this.shedding) {
      return
    }
    if (this.paused || this.queue.length > this.queueHead) {
      const bytes = Buffer.byteLength(JSON.stringify(codexSharedFrameParams(frame) ?? null), 'utf8')
      this.queue.push({ frame, bytes })
      this.queuedBytes += bytes
      this.host.backlog(this, bytes)
      if (this.queue.length - this.queueHead > CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES) {
        this.shed()
      }
      return
    }
    this.dispatch(frame)
  }

  /** Too far behind: drops its queue and ends it alone; it reopens its thread on its next send. */
  shed(): void {
    this.shedding = true
    this.dropQueue()
    this.fail(new Error('codex chat fell too far behind its shared app-server'), true)
  }

  private dropQueue(): void {
    this.host.backlog(this, -this.queuedBytes)
    this.queue = []
    this.queueHead = 0
    this.queuedBytes = 0
  }

  private get canDrain(): boolean {
    return !this.paused && this.queueHead < this.queue.length && this.state !== 'ended'
  }

  private drainQueue(): void {
    if (this.draining) {
      return
    }
    this.draining = true
    let budget = DRAIN_CHUNK_BYTES
    try {
      while (budget > 0 && this.canDrain) {
        const { frame, bytes } = this.queue[this.queueHead]!
        this.queueHead += 1
        this.queuedBytes -= bytes
        budget -= bytes
        this.host.backlog(this, -bytes)
        this.dispatch(frame)
      }
    } finally {
      this.queue.splice(0, this.queueHead)
      this.queueHead = 0
      this.draining = false
    }
    if (!this.drainScheduled && this.canDrain) {
      this.drainScheduled = true
      setImmediate(() => {
        this.drainScheduled = false
        this.drainQueue()
      })
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
      // A lease its server's exit ended reports once that server's tree is judged.
      return this.host.afterReap().then(() => true)
    }
    if (this.closing) {
      return this.closing
    }
    this.state = 'closing'
    const error = new Error('codex app-server connection closed')
    this.announceClose(error)
    const closing = this.releaseOnHost(error, true).then((ended) => {
      if (!ended && this.closing === closing) {
        // A turn still runs: report the close unproven so the caller tries again.
        this.closing = null
      }
      return ended
    })
    this.closing = closing
    return closing
  }

  /** Ends the lease once the server proves its turns stopped; false while one still runs. */
  private releaseOnHost(error: Error, expected: boolean): Promise<boolean> {
    this.releasing = true
    this.noteWaiting()
    return this.host
      .release(this)
      .catch((): CodexLeaseRelease => ({ writerStopped: true, workloadGone: false }))
      .then(({ writerStopped, workloadGone }) => {
        this.releasing = false
        this.noteWaiting()
        if (!writerStopped && this.state !== 'ended') {
          return false
        }
        this.finish(error, expected, workloadGone ? 'exited' : 'live')
        return true
      })
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
        this.finish(error, true, () => this.host.workloadVerdict())
      }
      return
    }
    this.state = 'closing'
    this.announceClose(error)
    this.paused = true
    if (!releaseOnServer) {
      this.finish(error, false, () => this.host.workloadVerdict())
      return
    }
    // The chat hears its exit only after its turns are stopped, so a recovery can't race them; a
    // close meanwhile waits on this same cleanup. No timer: it retries when something that could
    // prove it changes (a turn ends, another chat leaves, the server exits).
    const attempt = (): Promise<boolean> => {
      const closing = this.releaseOnHost(error, false).then((ended) => {
        if (!ended && this.closing === closing) {
          this.closing = null
          void this.host.releaseMayProve(this).then(() => {
            if (this.state === 'closing' && !this.closing) {
              this.closing = attempt()
            }
          })
        }
        return ended
      })
      return closing
    }
    this.closing = attempt()
  }

  private finish(
    error: Error,
    expected: boolean,
    workload: DescendantTreeVerdict | (() => DescendantTreeVerdict)
  ): void {
    if (this.state === 'ended') {
      return
    }
    this.state = 'ended'
    this.dropQueue()
    this.workload = typeof workload === 'function' ? workload : () => workload
    for (const giveUp of this.outstanding) {
      giveUp(new Error('codex app-server connection closed'))
    }
    this.handlers.onExit?.(error, { expected })
  }
}
