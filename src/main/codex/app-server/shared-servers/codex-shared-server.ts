import { spawnCodexAppServerConnection } from '../codex-app-server-connection'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { initializeCodexAppServerConnection } from '../codex-app-server-handshake'
import {
  stopCodexSharedChatWorkload,
  unsubscribeCodexThreads,
  type CodexSharedServerProcessSweep
} from './codex-shared-server-chat-workload'
import type { CodexSharedServerFrame } from './codex-shared-server-frames'
import type { DescendantTreeVerdict } from '../../../pty/process-retirement/pty-descendant-exit-verification'
import type { CodexSharedServerSpec } from './codex-shared-server-key'
import type {
  CodexLeaseRelease,
  CodexSharedLeaseHost,
  CodexSharedServerLease
} from './codex-shared-server-lease'
import { CodexSharedServerBacklog } from './codex-shared-server-backlog'
import { CodexSharedServerTurns } from './codex-shared-server-turns'
import { stopCodexLeaseWriter } from './codex-shared-server-writer-stop'
import { CodexSharedServerRouter } from './codex-shared-server-router'
import { retiringHungCodexServers } from './codex-shared-server-hang-watch'
import type { CodexSharedServerWindowsJob } from './codex-shared-server-windows-job'

const RELEASE_REQUEST_TIMEOUT_MS = 5_000
const INITIALIZE_TIMEOUT_MS = 15_000
const NO_OWNER_ERROR_CODE = -32000

/** One Codex app-server many chats lease; each chat's threads route to that chat alone. */
export class CodexSharedServer implements CodexSharedLeaseHost {
  readonly leases = new Set<CodexSharedServerLease>()
  /** Not offered to new chats; stops once its last chat leaves. */
  draining = false
  private physical: CodexAppServerConnection | null = null
  private hasExited = false
  private reaping: Promise<void> | null = null
  /** Threads a leaving chat is still cleaning up; a chat resuming one waits for that. */
  private readonly releasingThreads = new Map<string, Promise<void>>()
  private readonly releases = new WeakMap<CodexSharedServerLease, Promise<CodexLeaseRelease>>()
  private readonly turns = new CodexSharedServerTurns()
  private readonly backlogs = new CodexSharedServerBacklog(() => this.physical, this.leases)
  readonly router = new CodexSharedServerRouter(
    () => this.leases,
    (frame) => this.refuse(frame)
  )
  readonly ready: Promise<void>

  constructor(
    readonly spec: CodexSharedServerSpec,
    private readonly onEnded: (server: CodexSharedServer) => void,
    connect: typeof spawnCodexAppServerConnection = spawnCodexAppServerConnection,
    private readonly sweep?: CodexSharedServerProcessSweep,
    /** Windows only: holds the server's whole tree, so its close ends what chats left running. */
    private readonly windowsJob?: CodexSharedServerWindowsJob
  ) {
    this.ready = this.start(retiringHungCodexServers(connect))
  }

  private async start(connect: typeof spawnCodexAppServerConnection): Promise<void> {
    const connection = await connect(this.spec.launch, {
      onNotification: (method, params) => {
        this.turns.observe(method, params)
        this.router.onNotification(method, params)
      },
      onServerRequest: (request) => this.router.onServerRequest(request),
      onUnhandledFrame: (kind, payload) => {
        if (!this.router.onUnhandledFrame(kind, payload)) {
          console.warn(`[codex-shared-server] ${kind}`, this.pid ?? '')
        }
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
      // A server its Windows job can't hold couldn't end what chats leave running.
      await this.windowsJob?.requireHolds(connection.pid, () => this.hasExited)
    } catch (error) {
      // A server that never initialized serves nobody; the next chat gets a fresh one.
      this.draining = true
      if (this.windowsJob) {
        // Its waiting chats leave silently: their open rejects and a fallback reuses their handlers.
        this.leases.clear()
      }
      void this.closeProcess()
      throw error
    }
  }

  /** Every close of the process: the tree kill, then the Windows job ends anything it missed. */
  private async closeProcess(): Promise<boolean> {
    try {
      return this.physical ? await this.physical.close() : true
    } finally {
      this.windowsJob?.terminate()
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

  claim(
    threadId: string,
    lease: CodexSharedServerLease,
    opened?: boolean,
    history?: boolean
  ): void {
    this.router.claim(threadId, lease, opened, history)
  }

  backlog = (lease: CodexSharedServerLease, deltaBytes: number): void =>
    this.backlogs.change(lease, deltaBytes)
  turnsChanged = (): void => this.turns.changed()
  hasRunningTurn = (threads: Iterable<string>): boolean =>
    [...threads].some((threadId) => this.turns.runningOn(threadId) !== undefined)

  releaseMayProve(lease: CodexSharedServerLease): Promise<boolean> {
    const others = this.leases.size
    const threads = (): string[] => [...lease.threads, ...lease.abandonedThreads]
    const running = (): string[] => threads().flatMap((id) => this.turns.runningOn(id) ?? [])
    // A running turn no Stop has interrupted yet (a helper that started late) wakes the retry.
    const seen = lease.interruptedTurns
    return this.turns.waitUntil(
      () =>
        this.hasExited ||
        this.leases.size < others ||
        running().some((turnId) => !seen.has(turnId) && !lease.refusedInterrupts.has(turnId)) ||
        (lease.pendingOpens.size === 0 &&
          !this.turns.anyStartPending(threads()) &&
          !this.hasRunningTurn(threads())),
      null
    )
  }

  trackTurnStart(threadId: string, request: Promise<unknown>): void {
    this.turns.trackStart(threadId, request)
  }

  noteTurnStarted(threadId: string, turnId: string): void {
    this.turns.noteStarted(threadId, turnId)
  }

  /** Interrupts the chat's turns and waits for each to end, then stops its commands and
   *  unsubscribes the threads no later chat claimed. A turn that won't end keeps the chat on the
   *  server (its threads still routed to it) so a later close can try again; the server is
   *  stopped for proof only when no other chat is on it. */
  release(lease: CodexSharedServerLease): Promise<CodexLeaseRelease> {
    // Every caller (a close racing a failure's cleanup) waits on the one cleanup and its proof.
    let releasing = this.releases.get(lease)
    if (!releasing) {
      releasing = this.leases.has(lease)
        ? this.releaseLease(lease)
        : Promise.resolve({
            writerStopped: true,
            workloadGone: this.workloadVerdict() === 'exited'
          })
      this.releases.set(lease, releasing)
    }
    return releasing
  }

  private async releaseLease(lease: CodexSharedServerLease): Promise<CodexLeaseRelease> {
    let done = (): void => {}
    const released = new Promise<void>((resolve) => {
      done = resolve
    })
    // Abandoned threads too, so another chat can't resume one while this cleanup still runs.
    const fenced = [...lease.threads, ...lease.abandonedThreads]
    for (const threadId of fenced) {
      this.releasingThreads.set(threadId, released)
    }
    let result: CodexLeaseRelease = { writerStopped: false, workloadGone: false }
    try {
      result = await this.stopLeaseWork(lease)
      return result
    } finally {
      if (!result.writerStopped && !this.hasExited) {
        // Still running here: the chat keeps its threads and its place until a retry proves it.
        this.releases.delete(lease)
      } else {
        this.leases.delete(lease)
        this.turns.changed()
        this.router.openSettled()
        this.onEnded(this)
      }
      for (const threadId of fenced) {
        if (this.releasingThreads.get(threadId) === released) {
          this.releasingThreads.delete(threadId)
        }
      }
      done()
    }
  }

  private async stopLeaseWork(lease: CodexSharedServerLease): Promise<CodexLeaseRelease> {
    const physical = this.physical
    if (!physical) {
      return { writerStopped: true, workloadGone: true }
    }
    if (this.closed && !this.hasExited) {
      // A broken transport proves nothing about the process or its turns; only its exit does.
      await this.stop()
    }
    if (this.hasExited) {
      return this.reapedVerdict()
    }
    const writerStopped =
      !this.physical ||
      (await stopCodexLeaseWriter(this.physical, lease, this.turns, RELEASE_REQUEST_TIMEOUT_MS))
    if (!writerStopped && !this.hasExited) {
      await this.stopIfAlone(lease)
    }
    if (this.hasExited) {
      // An exit mid-wait ends every turn waiter without a turn/completed; only the reaped tree
      // can prove this chat's commands are gone.
      return this.reapedVerdict()
    }
    if (!writerStopped) {
      return { writerStopped: false, workloadGone: false }
    }
    // Only now do the chat's threads stop routing to it; their late frames are refused.
    this.leases.delete(lease)
    // A helper named only in history never loaded here: nothing to list, stop or unsubscribe.
    const owned = this.router.release(lease).filter((threadId) => lease.liveThreads.has(threadId))
    // Threads that opened after the chat left are let go here, and their commands stopped below.
    const abandonedGone = (await Promise.all(lease.abandoning)).every(Boolean)
    // Turns ending doesn't end the commands they started; the chat's own are stopped alone. Each
    // step runs even if an earlier one failed; any failure leaves the workload unproven.
    const commandsGone = await stopCodexSharedChatWorkload({
      rpc: physical,
      threads: [...owned, ...lease.abandonedThreads],
      leaseId: lease.id,
      ...(this.sweep ? { sweep: this.sweep } : {}),
      serverPid: this.pid,
      ...(physical.watcherPid !== undefined ? { watcherPid: physical.watcherPid } : {}),
      timeoutMs: RELEASE_REQUEST_TIMEOUT_MS
    }).catch(() => false)
    // A chat that resumed one of these threads here owns its subscription now; abandoned threads
    // were already let go by abandon().
    const unsubscribed = await unsubscribeCodexThreads(
      physical,
      owned.filter((threadId) => !this.router.isClaimed(threadId)),
      RELEASE_REQUEST_TIMEOUT_MS
    )
    const workloadGone = abandonedGone && commandsGone && unsubscribed
    if (!workloadGone && !this.hasExited) {
      await this.stopIfAlone(lease)
    }
    if (this.hasExited) {
      return this.reapedVerdict()
    }
    return { writerStopped: true, workloadGone }
  }

  private async reapedVerdict(): Promise<CodexLeaseRelease> {
    await this.afterReap()
    return { writerStopped: true, workloadGone: this.workloadVerdict() === 'exited' }
  }

  abandon(threadId: string, lease: CodexSharedServerLease): Promise<boolean> {
    // The chat's own provisional claim (a resume it gave up on) is let go; another chat's isn't.
    this.router.unclaim(threadId, lease)
    if (this.router.isClaimed(threadId)) {
      return Promise.resolve(true)
    }
    this.router.retire(threadId)
    lease.abandonedThreads.add(threadId)
    const letGo =
      !this.physical || this.closed
        ? Promise.resolve(false)
        : unsubscribeCodexThreads(this.physical, [threadId], RELEASE_REQUEST_TIMEOUT_MS)
    lease.abandoning.add(letGo)
    return letGo
  }

  threadReleased(threadId: string): Promise<void> {
    return this.releasingThreads.get(threadId) ?? Promise.resolve()
  }

  /** A chat's work that its own cleanup couldn't stop or prove gone: with no other chat on the
   *  server, stop the server (its exit reaps the tree); else drain it so it ends with the last. */
  private async stopIfAlone(lease: CodexSharedServerLease): Promise<void> {
    this.draining = true
    if ([...this.leases].some((other) => other !== lease) || !this.physical) {
      console.warn(`[codex-shared-server] pid ${this.pid ?? '?'}: chat work outlived cleanup`)
      return
    }
    await this.closeProcess()
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
    // A server that never spawned is trivially stopped.
    const closed = await this.closeProcess()
    return closed && (this.physical?.closeResult?.root ?? 'exited') === 'exited'
  }

  refuse(frame: CodexSharedServerFrame): void {
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
    this.backlogs.dispose()
    // Root exit says nothing of the commands it ran; reap and judge the tree for every chat.
    this.reaping = this.closeProcess().then(
      () => {},
      () => {}
    )
    // Every chat on it sees its own unexpected exit and reopens its thread on its next send.
    for (const lease of this.leases) {
      lease.fail(error, false)
    }
    this.leases.clear()
    this.router.clear()
    this.onEnded(this)
  }
}
