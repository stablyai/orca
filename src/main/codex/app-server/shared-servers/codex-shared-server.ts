import { spawnCodexAppServerConnection } from '../codex-app-server-connection'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { initializeCodexAppServerConnection } from '../codex-app-server-handshake'
import { isCodexAppServerUnsupportedError } from '../codex-app-server-session'
import {
  stopCodexSharedChatWorkload,
  type CodexSharedServerProcessSweep
} from './codex-shared-server-chat-workload'
import type { CodexSharedServerFrame } from './codex-shared-server-frames'
import type { DescendantTreeVerdict } from '../../../pty/process-retirement/pty-descendant-exit-verification'
import type { CodexSharedServerSpec } from './codex-shared-server-key'
import type { CodexSharedServerToolUsage } from './codex-shared-server-memory-ceiling'
import type { CodexSharedLeaseHost, CodexSharedServerLease } from './codex-shared-server-lease'
import { CodexSharedServerTurns, withDeadline } from './codex-shared-server-turns'
import { CodexSharedServerRouter } from './codex-shared-server-router'

const RELEASE_REQUEST_TIMEOUT_MS = 5_000
/** How long an interrupted turn has to report turn/completed before Stop counts it unproven. */
const TURN_STOP_PROOF_MS = 10_000
const INITIALIZE_TIMEOUT_MS = 15_000
const NO_OWNER_ERROR_CODE = -32000

/** One Codex app-server many chats lease; each chat's threads route to that chat alone. */
export class CodexSharedServer implements CodexSharedLeaseHost {
  readonly leases = new Set<CodexSharedServerLease>()
  /** Not offered to new chats; stops once its last chat leaves. */
  draining = false
  /** Bytes the server process used at the last sample. */
  memoryBytes: number | null = null
  /** Each chat's own tool processes under this server, at the last sample. */
  toolUsage: CodexSharedServerToolUsage[] = []
  private physical: CodexAppServerConnection | null = null
  private hasExited = false
  private reaping: Promise<void> | null = null
  /** Threads a leaving chat is still cleaning up; a chat resuming one waits for that. */
  private readonly releasingThreads = new Map<string, Promise<void>>()
  private readonly releases = new WeakMap<CodexSharedServerLease, Promise<boolean>>()
  private readonly turns = new CodexSharedServerTurns()
  private readonly router = new CodexSharedServerRouter(
    () => this.leases,
    (frame) => this.refuse(frame)
  )
  readonly ready: Promise<void>

  constructor(
    readonly spec: CodexSharedServerSpec,
    private readonly onEnded: (server: CodexSharedServer) => void,
    connect: typeof spawnCodexAppServerConnection = spawnCodexAppServerConnection,
    private readonly sweep?: CodexSharedServerProcessSweep
  ) {
    this.ready = this.start(connect)
  }

  private async start(connect: typeof spawnCodexAppServerConnection): Promise<void> {
    const connection = await connect(this.spec.launch, {
      onNotification: (method, params) => {
        this.turns.observe(method, params)
        this.router.onNotification(method, params)
      },
      onServerRequest: (request) => this.router.onServerRequest(request),
      onUnhandledFrame: (kind, payload) => {
        console.warn(`[codex-shared-server] ${kind}`, this.pid ?? '')
        void payload
      },
      onClose: (error) => {
        // Unusable from here even before its exit is proven; new chats must not pick it.
        this.draining = true
        for (const lease of this.leases) {
          lease.serverClosing(error)
        }
      },
      onExit: (error) => this.onExit(error)
    }).catch((error: unknown) => {
      this.onExit(error instanceof Error ? error : new Error(String(error)))
      throw error
    })
    this.physical = connection
    try {
      await initializeCodexAppServerConnection(connection, INITIALIZE_TIMEOUT_MS)
    } catch (error) {
      // A server that never initialized serves nobody; the next chat gets a fresh one.
      this.draining = true
      void connection.close()
      throw error
    }
  }

  get pid(): number | undefined {
    return this.physical?.pid
  }

  get exited(): boolean {
    return this.hasExited
  }

  get closed(): boolean {
    return this.hasExited || this.physical === null || this.physical.closed
  }

  get connection(): CodexAppServerConnection {
    if (!this.physical) {
      throw new Error('codex shared app-server is not running')
    }
    return this.physical
  }

  claim(threadId: string, lease: CodexSharedServerLease): void {
    this.router.claim(threadId, lease)
  }

  trackTurnStart(threadId: string, request: Promise<unknown>): void {
    this.turns.trackStart(threadId, request)
  }

  noteTurnStarted(threadId: string, turnId: string): void {
    this.turns.noteStarted(threadId, turnId)
  }

  /** Interrupts the chat's turns and waits for each to end, then unsubscribes the threads no
   *  later chat claimed. Resolves whether every turn is proven over; the server keeps running
   *  for other chats unless a stuck turn leaves no other chat working, when it stops. */
  release(lease: CodexSharedServerLease): Promise<boolean> {
    // Every caller (a close racing a failure's cleanup) waits on the one cleanup and its proof.
    let releasing = this.releases.get(lease)
    if (!releasing) {
      releasing = this.leases.has(lease) ? this.releaseLease(lease) : Promise.resolve(true)
      this.releases.set(lease, releasing)
    }
    return releasing
  }

  private async releaseLease(lease: CodexSharedServerLease): Promise<boolean> {
    this.leases.delete(lease)
    const owned = this.router.release(lease)
    let done = (): void => {}
    const released = new Promise<void>((resolve) => {
      done = resolve
    })
    for (const threadId of owned) {
      this.releasingThreads.set(threadId, released)
    }
    try {
      return await this.stopLeaseWork(lease, owned)
    } finally {
      for (const threadId of owned) {
        if (this.releasingThreads.get(threadId) === released) {
          this.releasingThreads.delete(threadId)
        }
      }
      done()
    }
  }

  private async stopLeaseWork(lease: CodexSharedServerLease, owned: string[]): Promise<boolean> {
    let threads = owned
    let proven = true
    const physical = this.physical
    if (physical && this.closed && !this.hasExited) {
      // A broken transport proves nothing about the process or its turns; only its exit does.
      await this.stop()
      await this.afterReap()
      proven = this.workloadVerdict() === 'exited'
    } else if (physical && !this.closed) {
      const options = { timeoutMs: RELEASE_REQUEST_TIMEOUT_MS }
      // Opens that answer from here on are abandoned (lease.ts), so none outlives the chat.
      await withDeadline(
        Promise.allSettled([...lease.pendingOpens, ...this.turns.startsPending(threads)]),
        RELEASE_REQUEST_TIMEOUT_MS
      )
      proven = lease.pendingOpens.size === 0 && !this.turns.anyStartPending(threads)
      // Threads that opened after the chat left are let go here, and their commands stopped below.
      proven &&= (await Promise.all(lease.abandoning)).every(Boolean)
      threads = [...threads, ...lease.abandonedThreads]
      const turns = threads.flatMap((threadId) => {
        const turnId = this.turns.runningOn(threadId)
        return turnId ? [{ threadId, turnId }] : []
      })
      const stopped = await Promise.all(
        turns.map(async ({ threadId, turnId }) => {
          const ended = this.turns.ended(turnId)
          await physical.request('turn/interrupt', { threadId, turnId }, options).catch(() => {})
          return withDeadline(ended, TURN_STOP_PROOF_MS)
        })
      )
      proven &&= stopped.every(Boolean)
      if (!proven && !this.hasExited) {
        proven = await this.handleStuckTurn()
      }
      if (this.hasExited) {
        // An exit mid-wait ends every turn waiter without a turn/completed; only the reaped tree
        // can prove this chat's commands are gone.
        await this.afterReap()
        proven = this.workloadVerdict() === 'exited'
      }
      if (!this.closed) {
        // Turns ending doesn't end the commands they started; the chat's own are stopped alone.
        const workloadStopped = await stopCodexSharedChatWorkload({
          rpc: physical,
          threads,
          leaseId: lease.id,
          ...(this.sweep ? { sweep: this.sweep } : {}),
          serverPid: this.pid,
          timeoutMs: RELEASE_REQUEST_TIMEOUT_MS
        })
        // A chat that already resumed one of these threads here owns its subscription now.
        // Abandoned threads were already let go by abandon().
        const unclaimed = owned.filter((threadId) => !this.router.isClaimed(threadId))
        const unsubscribed = await Promise.allSettled(
          unclaimed.map((threadId) => physical.request('thread/unsubscribe', { threadId }, options))
        )
        proven &&=
          workloadStopped &&
          unsubscribed.every(
            (result) =>
              result.status === 'fulfilled' || isCodexAppServerUnsupportedError(result.reason)
          )
      }
    }
    this.onEnded(this)
    return proven
  }

  abandon(threadId: string, lease: CodexSharedServerLease): Promise<boolean> {
    if (this.router.isClaimed(threadId)) {
      return Promise.resolve(true)
    }
    this.router.retire(threadId)
    lease.abandonedThreads.add(threadId)
    const physical = this.physical
    const letGo =
      !physical || this.closed
        ? Promise.resolve(false)
        : physical
            .request('thread/unsubscribe', { threadId }, { timeoutMs: RELEASE_REQUEST_TIMEOUT_MS })
            .then(
              () => true,
              (error: unknown) => isCodexAppServerUnsupportedError(error)
            )
    lease.abandoning.add(letGo)
    return letGo
  }

  threadReleased(threadId: string): Promise<void> {
    return this.releasingThreads.get(threadId) ?? Promise.resolve()
  }

  /** A turn that ignores Stop: stop the server if no other chat is working, else drain it. */
  private async handleStuckTurn(): Promise<boolean> {
    this.draining = true
    const othersWorking = [...this.leases].some((other) => {
      const threads = [...other.threads]
      return (
        this.turns.anyStartPending(threads) ||
        threads.some((threadId) => this.turns.runningOn(threadId) !== undefined)
      )
    })
    if (othersWorking || !this.physical) {
      console.warn(`[codex-shared-server] pid ${this.pid ?? '?'}: a stopped turn kept running`)
      return false
    }
    await this.physical.close()
    const result = this.physical.closeResult
    return result?.root === 'exited' && result.tree === 'exited'
  }

  /** Whether the process's descendants (the chats' commands) were proven gone when it closed. */
  workloadVerdict(): DescendantTreeVerdict {
    if (!this.physical) {
      return 'exited'
    }
    return this.physical.closeResult?.tree ?? 'unverifiable'
  }

  /** Settles once an exited server's process tree has been reaped and judged. */
  afterReap(): Promise<void> {
    return this.reaping ?? Promise.resolve()
  }

  /** Stops the process (only the pool calls this, for a server with no chats left); resolves
   *  whether its exit is proven. */
  async stop(): Promise<boolean> {
    this.draining = true
    await this.ready.catch(() => {})
    if (!this.physical) {
      return true
    }
    return (await this.physical.close()) && this.physical.closeResult?.root === 'exited'
  }

  private refuse(frame: CodexSharedServerFrame): void {
    if (frame.kind === 'request' && !this.closed) {
      this.physical?.respondWithError(
        frame.request.id,
        NO_OWNER_ERROR_CODE,
        'no Orca chat holds this thread'
      )
    }
  }

  private onExit(error: Error): void {
    if (this.hasExited) {
      return
    }
    this.hasExited = true
    this.draining = true
    this.turns.endAll()
    // Root exit says nothing of the commands it ran; reap and judge the tree for every chat.
    const physical = this.physical
    this.reaping = physical
      ? physical.close().then(
          () => {},
          () => {}
        )
      : Promise.resolve()
    // Every chat on it sees its own unexpected exit and reopens its thread on its next send.
    for (const lease of this.leases) {
      lease.fail(error, false)
    }
    this.leases.clear()
    this.router.clear()
    this.onEnded(this)
  }
}
