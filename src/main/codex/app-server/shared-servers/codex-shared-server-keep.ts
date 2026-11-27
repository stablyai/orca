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
import {
  stopCodexSharedChatWorkload,
  unsubscribeCodexThreads,
  type CodexSharedServerProcessSweep
} from './codex-shared-server-chat-workload'
import type { CodexSharedServerFrame } from './codex-shared-server-frames'
import type { CodexSharedLeaseRelay } from './codex-shared-lease-host'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import type { CodexRecoveredGroup, CodexSharedServerRecovery } from './codex-shared-server-recovery'
import type { CodexSharedServerRouter } from './codex-shared-server-router'
import type { CodexSharedRelayAcks } from './codex-shared-server-relay'

const CLEANUP_TIMEOUT_MS = 5_000

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

  floor = (): number | null => {
    let floor = this.server.router.floor()
    for (const lease of this.server.leases) {
      const seq = lease.queue.firstSeq()
      if (seq !== null && (floor === null || seq < floor)) {
        floor = seq
      }
    }
    return floor
  }

  durable = async (force: boolean): Promise<boolean> => {
    // A chat quit handed off saved everything it was handed then, and is handed nothing since.
    const chats = [...this.server.leases].flatMap((lease) =>
      lease.handedOff || lease.sessionId === null ? [] : [lease.sessionId]
    )
    const saved = await Promise.all(chats.map((chat) => providerRelayChatDurable(chat, force)))
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
    if (lease.sessionId !== null) {
      await providerRelayChatDurable(lease.sessionId, true).catch(() => false)
    }
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
    if (chat && !this.server.exited) {
      const { recovery } = this.server
      recovery.expect(chat)
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
    for (const root of this.server.recovery.dueUnresolved()) {
      const source = await readSource(connection, root, SOFT_READ_TIMEOUT_MS).catch(() => null)
      if (!source || !this.server.recovery.holds(root)) {
        continue
      }
      if (source.parentThreadId) {
        this.server.router.ownerFound(root, source.parentThreadId)
      } else {
        await this.letGo(this.server.recovery.take(root))
      }
    }
    this.server.ended()
  }

  /** Threads the reattach found no chat wants. */
  async unsubscribe(threads: readonly string[]): Promise<void> {
    const connection = this.server.physicalConnection
    if (connection && threads.length > 0) {
      await unsubscribeCodexThreads(connection, threads, CLEANUP_TIMEOUT_MS).catch(() => false)
    }
  }

  private async letGo(released: CodexRecoveredGroup | null): Promise<void> {
    if (!released) {
      return
    }
    this.server.recovery.drop(released)
    const threads = released.threads.map(([threadId]) => threadId)
    const connection = this.server.physicalConnection
    if (released.chat && connection && !connection.closed) {
      await stopCodexSharedChatWorkload({
        rpc: connection,
        threads,
        leaseId: released.chat.workload,
        serverPid: this.server.pid,
        ...(this.server.sweep ? { sweep: this.server.sweep } : {}),
        ...(connection.watcherPid !== undefined ? { watcherPid: connection.watcherPid } : {}),
        timeoutMs: CLEANUP_TIMEOUT_MS
      }).catch(() => false)
    }
    await this.unsubscribe(threads)
    this.server.ended()
  }
}
