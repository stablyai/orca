import {
  detachProviderRelayForQuit,
  providerRelayChatDurable,
  providerRelayQuitting,
  trackProviderRelayQuitWork
} from '../../../provider-relay/app-provider-relays'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import {
  readSource,
  SOFT_READ_TIMEOUT_MS
} from '../../structured/threads/codex-kept-loaded-threads'
import type { CodexSharedServerProcessSweep } from './codex-shared-server-chat-workload'
import { endCodexSharedThreads } from './codex-shared-server-thread-end'
import { CODEX_SHARED_REATTACH_READS } from './codex-shared-server-reattach'
import { mapSettledWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import type { CodexSharedServerFrame } from './codex-shared-server-frames'
import type { CodexSharedLeaseRelay } from './codex-shared-lease-host'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import type { CodexRecoveredGroup, CodexSharedServerRecovery } from './codex-shared-server-recovery'
import type { CodexSharedServerRouter } from './codex-shared-server-router'
import type { CodexSharedRelayAcks } from './codex-shared-server-relay'

type Work = Record<string, string[][]>

/** What the keep side reads of its server. */
export type CodexKeptServer = {
  readonly leases: Set<CodexSharedServerLease>
  readonly router: CodexSharedServerRouter
  readonly recovery: CodexSharedServerRecovery
  readonly physicalConnection: CodexAppServerConnection | null
  readonly relayed?: { chatKey: string } | undefined
  readonly exited: boolean
  readonly pid: number | undefined
  readonly sweep?: CodexSharedServerProcessSweep | undefined
  /** Re-judges the server once a chat or its held threads left. */
  ended: () => void
  stop: () => Promise<boolean>
}

function mergeWork(into: Work | null | undefined, open: Work | null): Work | null {
  if (into === null || open === null) {
    return null
  }
  const merged: Work = { ...into }
  for (const [group, keys] of Object.entries(open)) {
    merged[group] = [...(merged[group] ?? []), ...keys]
  }
  return merged
}

/**
 * A relayed shared server's side that outlives this app: its acks wait on every chat's journal and
 * hold at what any chat hasn't taken; quit hands each keepable chat's part to the daemon, ending
 * nothing, and the server goes on once no chat on it is still open here.
 */
export class CodexSharedServerKeep implements CodexSharedLeaseRelay, CodexSharedRelayAcks {
  /** Open work of the chats quit handed off; null once one couldn't say (never idle-stopped). */
  private quitOpen: Work | null | undefined
  private handedOff = false

  constructor(private readonly server: CodexKeptServer) {}

  private get relay() {
    return this.server.physicalConnection?.relay
  }

  openWork = () => this.relay?.openWork()
  endedWork = () => this.relay?.endedWork()
  recordSeq = () => this.relay?.recordSeq?.() ?? null

  /** Chats handed frames since their journal last held them all; only these are asked to save. */
  private readonly unsaved = new Set<CodexSharedServerLease>()
  /** Chats with frames queued (paused, held, or handed off); only these can hold the floor. */
  private readonly queued = new Set<CodexSharedServerLease>()
  /** A handed-off chat's last save; the final ack waits for it. */
  private readonly quitSaves = new Map<CodexSharedServerLease, Promise<boolean>>()

  dispatched(lease: CodexSharedServerLease): void {
    this.unsaved.add(lease)
  }

  queueChanged(lease: CodexSharedServerLease): void {
    if (lease.queue.pending > 0) {
      this.queued.add(lease)
    } else {
      this.queued.delete(lease)
    }
  }

  /** A chat left the server: it holds nothing for the acks any more. */
  forget(lease: CodexSharedServerLease): void {
    this.unsaved.delete(lease)
    this.queued.delete(lease)
  }

  floor = (): number | null => {
    let floor = this.server.router.floor()
    for (const lease of this.queued) {
      const seq = lease.queue.firstSeq()
      if (seq !== null && (floor === null || seq < floor)) {
        floor = seq
      }
    }
    return floor
  }

  durable = async (force: boolean): Promise<boolean> => {
    // A chat quit handed off is handed nothing more: its own last save stands for it.
    const asked = [...this.unsaved].filter((lease) => !lease.handedOff)
    this.unsaved.clear()
    const saved = await Promise.all([
      ...asked.map(async (lease) => {
        const ok =
          lease.sessionId === null ||
          (await providerRelayChatDurable(lease.sessionId, force).catch(() => false))
        if (!ok && this.server.leases.has(lease)) {
          this.unsaved.add(lease)
        }
        return ok
      }),
      ...this.quitSaves.values()
    ])
    return saved.every(Boolean)
  }

  async detachForQuit(lease: CodexSharedServerLease, open: Work | null): Promise<void> {
    if (lease.handedOff || !this.server.leases.has(lease)) {
      return
    }
    // Nothing more is dispatched to it; what it was handed is saved before its journal closes.
    lease.handedOff = true
    lease.unregister()
    this.quitOpen = mergeWork(this.quitOpen === undefined ? {} : this.quitOpen, open)
    const saved =
      lease.sessionId === null
        ? Promise.resolve(true)
        : providerRelayChatDurable(lease.sessionId, true).catch(() => false)
    this.quitSaves.set(lease, saved)
    await saved
    this.settleQuit()
  }

  /** Quit: once no chat here is still open on it, the server goes to the daemon or stops. */
  settleQuit(): void {
    if (!providerRelayQuitting() || this.handedOff || this.server.exited) {
      return
    }
    const leases = [...this.server.leases]
    if (leases.some((lease) => !lease.handedOff)) {
      return
    }
    this.handedOff = true
    if (leases.length > 0 || !this.server.recovery.empty) {
      const open = this.quitOpen === undefined ? null : this.quitOpen
      trackProviderRelayQuitWork(
        detachProviderRelayForQuit(this.server.relayed?.chatKey ?? '', open)
      )
    } else {
      trackProviderRelayQuitWork(this.server.stop())
    }
  }

  /** A restored chat's open failed: its threads, and the frames it never saw, wait for it again. */
  handBack(lease: CodexSharedServerLease, frames: CodexSharedServerFrame[]): void {
    const chat = lease.restored?.chat
    const threads = this.server.router.handBack(lease)
    this.server.leases.delete(lease)
    this.forget(lease)
    this.quitSaves.delete(lease)
    if (chat && !this.server.exited) {
      const { recovery } = this.server
      recovery.expect(chat)
      if (lease.recoveryCut) {
        recovery.markCut(chat.threadId)
      }
      for (const threadId of threads) {
        if (threadId !== chat.threadId) {
          recovery.join(threadId, chat.threadId)
        }
      }
      for (const frame of [...frames, ...this.server.router.takeUnrouted(threads)]) {
        recovery.hold(frame.threadId ?? chat.threadId, frame)
      }
    }
    this.server.ended()
  }

  /** The chat no longer wants its part (deleted, or its record names another run): its held
   *  threads go, with their commands stopped under its tag and Codex told to let them go. */
  async releaseExpected(sessionId: string): Promise<void> {
    const released = this.server.recovery.release(sessionId)
    if (released) {
      await this.letGo(released)
    }
  }

  /** Unresolved roots due a read: an owner found moves them, a top-level root lets them go. */
  async retryUnresolved(): Promise<void> {
    const connection = this.server.physicalConnection
    if (!connection || connection.closed) {
      return
    }
    await mapSettledWithConcurrency(
      this.server.recovery.dueUnresolved(),
      CODEX_SHARED_REATTACH_READS,
      async (root) => {
        const source = await readSource(connection, root, SOFT_READ_TIMEOUT_MS).catch(() => null)
        if (!source || !this.server.recovery.holds(root)) {
          return
        }
        if (source.parentThreadId) {
          this.server.router.ownerFound(root, source.parentThreadId)
        } else {
          await this.letGo(this.server.recovery.take(root))
        }
      }
    )
    this.server.ended()
  }

  /** Threads no chat will take back: their turns and commands end, and Codex lets them go. */
  async endThreads(threads: readonly string[], workload: string | null): Promise<void> {
    const connection = this.server.physicalConnection
    if (connection) {
      await endCodexSharedThreads({
        connection,
        threads,
        workload,
        serverPid: this.server.pid,
        ...(this.server.sweep ? { sweep: this.server.sweep } : {})
      }).catch(() => {})
    }
  }

  private async letGo(released: CodexRecoveredGroup | null): Promise<void> {
    if (!released) {
      return
    }
    this.server.recovery.drop(released)
    await this.endThreads(
      released.threads.map(([threadId]) => threadId),
      released.chat?.workload ?? null
    )
    this.server.ended()
  }
}
