import { randomUUID } from 'node:crypto'
import type { ProviderProcessCloseResult } from '../../../provider-process/provider-process-close'
import type { DescendantTreeVerdict } from '../../../pty/process-retirement/pty-descendant-exit-verification'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import type { CodexSharedServerFrame } from './codex-shared-server-frames'
import { CodexSharedLeaseQueue } from './codex-shared-lease-queue'
import { sendCodexLeaseRequest } from './codex-shared-server-lease-requests'
import {
  dispatchCodexLeaseFrame,
  endCodexLeaseQuietly,
  codexSharedLeaseRelayView,
  registerCodexSharedLeaseChat,
  type CodexLeaseRelease,
  type CodexSharedLeaseHost
} from './codex-shared-lease-host'

/** A paused chat holds its own frames; past this it is dropped instead of stalling the server.
 *  Bytes are bounded per server (codex-shared-server-backlog.ts). */
export const CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES = 20_000

/** One chat's view of a shared app-server: its threads' frames, its own backpressure and close. */
export class CodexSharedServerLease implements CodexAppServerConnection {
  readonly threads = new Set<string>()
  /** Threads this server has loaded (opened, or sent a frame for); a helper named only in history
   *  never ran here, so a close sends it nothing. */
  readonly liveThreads = new Set<string>()
  /** Tags every command this chat's threads run (CODEX_SHARED_LEASE_ENV); a restored lease keeps
   *  its run's, so Stop after a restart finds commands started before it. */
  readonly id: string
  /** thread/start, /resume and /fork still awaiting Codex; close waits for them. */
  readonly pendingOpens = new Set<Promise<unknown>>()
  readonly resumedThreads = new Set<string>()
  /** Turns a Stop of this chat's has interrupted; one running that isn't here needs its own. */
  readonly interruptedTurns = new Set<string>()
  /** Interrupts Codex refused; the next Stop re-sends them, but they never wake a retry. */
  readonly refusedInterrupts = new Set<string>()
  readonly outstanding = new Set<(error: Error) => void>()
  /** Threads that opened after this chat left, and the server letting each go. */
  readonly abandonedThreads = new Set<string>()
  readonly abandoning = new Set<Promise<boolean>>()
  private workload: (() => DescendantTreeVerdict) | null = null
  private state: 'open' | 'closing' | 'ended' = 'open'
  /** Quit handed its part to the daemon: it dispatches nothing more and stops nothing. */
  handedOff = false
  /** A kept run's close couldn't list its loaded threads or read some thread's turn. */
  readsFailed = false
  /** Timed retries so far while reads fail, for their backoff. */
  readRetries = 0
  readonly unregister: () => void
  private closing: Promise<boolean> | null = null
  private closeAnnounced = false
  private paused = false
  readonly queue = new CodexSharedLeaseQueue({
    canDispatch: () => !this.paused && !this.handedOff && this.state !== 'ended',
    dispatch: (frame) => this.dispatch(frame),
    backlog: (deltaBytes) => this.host.backlog(this, deltaBytes),
    refuse: (frame) => this.host.refuse(frame)
  })
  /** Dropped for falling behind: its frames are discarded until it ends. */
  private shedding = false
  /** Its cleanup is running and needs the shared reader. */
  private releasing = false

  constructor(
    readonly host: CodexSharedLeaseHost,
    private readonly handlers: CodexAppServerConnectionHandlers,
    readonly sessionId: string | null,
    /** Set on every thread this chat opens, so its commands keep the chat's identity. */
    readonly chatEnv: Readonly<Record<string, string>> = {},
    /** The workload id of the chat's run kept on this server from before this app started: its
     *  commands keep their tag, so Stop finds those started before. Null for a new run. */
    readonly keptWorkload: string | null = null,
    /** Its run may outlive this app (false: a bot chat whose grants end with it). */
    readonly keepable = true
  ) {
    this.id = keptWorkload ?? randomUUID()
    this.unregister = registerCodexSharedLeaseChat(this, () => this.state !== 'ended')
  }

  /** Its run was kept on this server from before this app started. */
  get restored(): boolean {
    return this.keptWorkload !== null
  }

  /** What the chat sees of the daemon running its server; absent when its run ends with this app. */
  get relay(): CodexAppServerConnection['relay'] {
    return codexSharedLeaseRelayView(this)
  }

  /** Leaves this app stopping nothing of its run (quit, or a kept run's failed reopen). */
  endQuietly(): void {
    if (this.state !== 'ended') {
      this.state = 'ended'
      this.workload = () => 'exited'
      endCodexLeaseQuietly(this)
    }
  }

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

  claim = (threadId: string, opened?: boolean, history?: boolean): void =>
    this.host.claim(threadId, this, opened, history)
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
    if (this.state === 'open' && this.host.answer(id)) {
      this.host.connection.respond(id, result)
    }
  }

  respondWithError(id: number | string, code: number, message: string): void {
    if (this.state === 'open' && this.host.answer(id)) {
      this.host.connection.respondWithError(id, code, message)
    }
  }

  pauseReading = (): void => {
    this.paused = true
    this.noteWaiting()
  }

  resumeReading = (): void => {
    this.paused = false
    this.queue.drain()
    this.noteWaiting()
  }

  get reading(): boolean {
    return !this.paused && !this.shedding && this.state !== 'ended'
  }

  /** Reading and owed frames: a paused shared reader would stall this chat. */
  get waiting(): boolean {
    return (
      this.releasing ||
      (this.state === 'open' &&
        !this.paused &&
        // One still catching up on its own queue waits on itself, not on the others.
        this.queue.bytes === 0 &&
        (this.outstanding.size > 0 || this.host.hasRunningTurn(this.threads)))
    )
  }

  noteWaiting(): void {
    this.host.backlog(this, 0)
  }

  deliver(frame: CodexSharedServerFrame): void {
    // A chat that is leaving can't answer; Codex gets a refusal instead of waiting forever.
    if (frame.kind === 'request' && (this.state !== 'open' || this.shedding)) {
      this.host.refuse(frame)
      return
    }
    if (this.state === 'ended' || this.shedding) {
      return
    }
    if (this.paused || this.handedOff || this.queue.pending > 0) {
      if (this.queue.push(frame) > CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES) {
        this.shed()
      }
      return
    }
    this.dispatch(frame)
  }

  /** Too far behind: drops its queue and ends it alone; it reopens its thread on its next send. */
  shed(): void {
    this.shedding = true
    this.queue.drop()
    this.fail(new Error('codex chat fell too far behind its shared app-server'), true)
  }

  private dispatch(frame: CodexSharedServerFrame): void {
    // A request drained from the queue after this chat began leaving gets the same refusal.
    if (frame.kind === 'request' && (this.state !== 'open' || this.shedding)) {
      this.host.refuse(frame)
      return
    }
    dispatchCodexLeaseFrame(this.handlers, frame, (error) => this.fail(error, true))
  }

  /** The server is up and this chat may use it; a rejection from onSpawned ends the lease. */
  async announce(): Promise<void> {
    const pid = this.host.pid
    if (pid !== undefined) {
      await this.handlers.onSpawned?.(pid)
    }
  }

  close(): Promise<boolean> {
    if (this.handedOff) {
      this.endQuietly()
      return Promise.resolve(true)
    }
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
    this.unregister()
    this.queue.drop()
    this.workload = typeof workload === 'function' ? workload : () => workload
    for (const giveUp of this.outstanding) {
      giveUp(new Error('codex app-server connection closed'))
    }
    this.handlers.onExit?.(error, { expected })
  }
}
