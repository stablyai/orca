import { spawnCodexAppServerConnection } from '../codex-app-server-connection'
import type {
  CodexAppServerConnection,
  CodexAppServerServerRequest
} from '../codex-app-server-connection-types'
import { initializeCodexAppServerConnection } from '../codex-app-server-handshake'
import {
  codexFrameThreadId,
  codexSharedFrameParams,
  codexSubagentParentThreadId,
  type CodexSharedServerFrame
} from './codex-shared-server-frames'
import type { CodexSharedServerSpec } from './codex-shared-server-key'
import type { CodexSharedServerToolUsage } from './codex-shared-server-memory-ceiling'
import type { CodexSharedLeaseHost, CodexSharedServerLease } from './codex-shared-server-lease'
import { CodexSharedServerTurns, withDeadline } from './codex-shared-server-turns'
import { CodexSharedServerUnrouted } from './codex-shared-server-unrouted'

const MAX_RETIRED_THREADS = 4_096
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
  private readonly owners = new Map<string, CodexSharedServerLease>()
  private readonly releases = new WeakMap<CodexSharedServerLease, Promise<boolean>>()
  private readonly turns = new CodexSharedServerTurns()
  private readonly retired = new Set<string>()
  private readonly unrouted = new CodexSharedServerUnrouted((frame) => this.refuse(frame))
  readonly ready: Promise<void>

  constructor(
    readonly spec: CodexSharedServerSpec,
    private readonly onEnded: (server: CodexSharedServer) => void,
    connect: typeof spawnCodexAppServerConnection = spawnCodexAppServerConnection
  ) {
    this.ready = this.start(connect)
  }

  private async start(connect: typeof spawnCodexAppServerConnection): Promise<void> {
    const connection = await connect(this.spec.launch, {
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (request) => this.onServerRequest(request),
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
    const previous = this.owners.get(threadId)
    if (previous && previous !== lease) {
      previous.threads.delete(threadId)
    }
    this.owners.set(threadId, lease)
    lease.threads.add(threadId)
    this.retired.delete(threadId)
    for (const frame of this.unrouted.take(threadId)) {
      lease.deliver(frame)
    }
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
    const threads = [...lease.threads]
    for (const threadId of threads) {
      if (this.owners.get(threadId) === lease) {
        this.owners.delete(threadId)
        this.retire(threadId)
      }
    }
    lease.threads.clear()
    let proven = true
    const physical = this.physical
    if (physical && this.closed && !this.hasExited) {
      // A broken transport proves nothing about the process or its turns; only its exit does.
      proven = await this.stop()
    } else if (physical && !this.closed) {
      const options = { timeoutMs: RELEASE_REQUEST_TIMEOUT_MS }
      await withDeadline(
        Promise.allSettled(this.turns.startsPending(threads)),
        RELEASE_REQUEST_TIMEOUT_MS
      )
      proven = !this.turns.anyStartPending(threads)
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
      if (!proven) {
        proven = await this.handleStuckTurn()
      }
      if (!this.closed) {
        // A chat that already resumed one of these threads here owns its subscription now.
        const unclaimed = threads.filter((threadId) => !this.owners.has(threadId))
        await Promise.allSettled(
          unclaimed.map((threadId) => physical.request('thread/unsubscribe', { threadId }, options))
        )
      }
    }
    this.onEnded(this)
    return proven
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

  private retire(threadId: string): void {
    this.retired.add(threadId)
    if (this.retired.size > MAX_RETIRED_THREADS) {
      const oldest = this.retired.values().next()
      if (!oldest.done) {
        this.retired.delete(oldest.value)
      }
    }
  }

  private onNotification(method: string, params: unknown): void {
    this.turns.observe(method, params)
    if (method === 'thread/started') {
      const parent = codexSubagentParentThreadId(params)
      const threadId = codexFrameThreadId(params)
      const owner = parent ? this.owners.get(parent) : undefined
      if (threadId && owner?.open) {
        this.claim(threadId, owner)
      }
    }
    this.route({ kind: 'notification', method, params })
  }

  private onServerRequest(request: CodexAppServerServerRequest): void {
    this.route({ kind: 'request', request })
  }

  private route(frame: CodexSharedServerFrame): void {
    const threadId = codexFrameThreadId(codexSharedFrameParams(frame))
    if (threadId === null) {
      this.routeServerWide(frame)
      return
    }
    const owner = this.owners.get(threadId)
    if (owner) {
      owner.deliver(frame)
      return
    }
    if (this.retired.has(threadId)) {
      this.refuse(frame)
      return
    }
    this.unrouted.hold(threadId, frame)
  }

  /** Account and rate-limit frames: each chat would have had its own copy from its own server. */
  private routeServerWide(frame: CodexSharedServerFrame): void {
    if (frame.kind === 'request') {
      const first = [...this.leases].find((lease) => lease.open)
      if (first) {
        first.deliver(frame)
      } else {
        this.refuse(frame)
      }
      return
    }
    for (const lease of this.leases) {
      lease.deliver(frame)
    }
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
    this.unrouted.clear()
    this.turns.endAll()
    // Every chat on it sees its own unexpected exit and reopens its thread on its next send.
    for (const lease of this.leases) {
      lease.fail(error, false)
    }
    this.leases.clear()
    this.owners.clear()
    this.onEnded(this)
  }
}
