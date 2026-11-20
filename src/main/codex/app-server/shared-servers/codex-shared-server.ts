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

/** Frames for a thread no chat has claimed yet (e.g. thread/started before thread/start replies). */
const MAX_UNROUTED_FRAMES = 2_000
const UNROUTED_TTL_MS = 30_000
const MAX_RETIRED_THREADS = 4_096
const RELEASE_REQUEST_TIMEOUT_MS = 5_000
const INITIALIZE_TIMEOUT_MS = 15_000
const NO_OWNER_ERROR_CODE = -32000

type UnroutedFrames = { frames: CodexSharedServerFrame[]; since: number }

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
  private readonly retired = new Set<string>()
  private readonly unrouted = new Map<string, UnroutedFrames>()
  private unroutedCount = 0
  private unroutedTimer: ReturnType<typeof setTimeout> | null = null
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
    const waiting = this.unrouted.get(threadId)
    if (waiting) {
      this.unrouted.delete(threadId)
      this.unroutedCount -= waiting.frames.length
      for (const frame of waiting.frames) {
        lease.deliver(frame)
      }
    }
  }

  /** Interrupts the chat's running turns and unsubscribes its threads; the server keeps running. */
  async release(lease: CodexSharedServerLease): Promise<void> {
    if (!this.leases.delete(lease)) {
      return
    }
    const threads = [...lease.threads]
    const turns = [...lease.activeTurns]
    for (const threadId of threads) {
      if (this.owners.get(threadId) === lease) {
        this.owners.delete(threadId)
        this.retire(threadId)
      }
    }
    lease.threads.clear()
    lease.activeTurns.clear()
    const physical = this.physical
    if (physical && !this.closed) {
      const options = { timeoutMs: RELEASE_REQUEST_TIMEOUT_MS }
      const interrupts = await Promise.allSettled(
        turns.map(([threadId, turnId]) =>
          physical.request('turn/interrupt', { threadId, turnId }, options)
        )
      )
      // A turn that ignores Stop keeps running here; take no new chats so the server can drain.
      if (interrupts.some((result) => result.status === 'rejected')) {
        this.draining = true
      }
      await Promise.allSettled(
        threads.map((threadId) => physical.request('thread/unsubscribe', { threadId }, options))
      )
    }
    this.onEnded(this)
  }

  /** Stops the process; only the pool calls this, for a server with no chats left. */
  async stop(): Promise<void> {
    this.draining = true
    await this.ready.catch(() => {})
    await this.physical?.close()
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
    this.hold(threadId, frame)
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

  private hold(threadId: string, frame: CodexSharedServerFrame): void {
    const bucket = this.unrouted.get(threadId) ?? { frames: [], since: Date.now() }
    bucket.frames.push(frame)
    this.unrouted.set(threadId, bucket)
    this.unroutedCount += 1
    while (this.unroutedCount > MAX_UNROUTED_FRAMES) {
      this.dropOldestUnrouted()
    }
    this.unroutedTimer ??= setTimeout(() => this.sweepUnrouted(), UNROUTED_TTL_MS)
    this.unroutedTimer.unref?.()
  }

  private dropOldestUnrouted(): void {
    const oldest = this.unrouted.entries().next()
    if (oldest.done) {
      this.unroutedCount = 0
      return
    }
    const [threadId, bucket] = oldest.value
    this.unrouted.delete(threadId)
    this.unroutedCount -= bucket.frames.length
    for (const frame of bucket.frames) {
      this.refuse(frame)
    }
  }

  private sweepUnrouted(): void {
    this.unroutedTimer = null
    const cutoff = Date.now() - UNROUTED_TTL_MS
    for (const [threadId, bucket] of this.unrouted) {
      if (bucket.since <= cutoff) {
        this.unrouted.delete(threadId)
        this.unroutedCount -= bucket.frames.length
        for (const frame of bucket.frames) {
          this.refuse(frame)
        }
      }
    }
    if (this.unrouted.size > 0) {
      this.unroutedTimer = setTimeout(() => this.sweepUnrouted(), UNROUTED_TTL_MS)
      this.unroutedTimer.unref?.()
    }
  }

  private onExit(error: Error): void {
    if (this.hasExited) {
      return
    }
    this.hasExited = true
    this.draining = true
    if (this.unroutedTimer) {
      clearTimeout(this.unroutedTimer)
      this.unroutedTimer = null
    }
    this.unrouted.clear()
    this.unroutedCount = 0
    // Every chat on it sees its own unexpected exit and reopens its thread on its next send.
    for (const lease of this.leases) {
      lease.fail(error, false)
    }
    this.leases.clear()
    this.owners.clear()
    this.onEnded(this)
  }
}
