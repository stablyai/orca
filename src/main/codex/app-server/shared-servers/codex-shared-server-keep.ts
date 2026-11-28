import {
  detachProviderRelayForQuit,
  detachProviderRelayToDaemon,
  providerRelayQuitting,
  trackProviderRelayQuitWork
} from '../../../provider-relay/app-provider-relays'
import type { CodexAppServerConnection } from '../codex-app-server-connection-types'
import { PrioritySemaphore } from '../../../../shared/concurrency/priority-semaphore'
import type { CodexSharedLeaseRelay } from './codex-shared-lease-host'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import type { CodexSharedServerRouter } from './codex-shared-server-router'
import type { CodexSharedRelayAcks } from './codex-shared-server-relay'
import {
  CODEX_SHARED_METADATA_READS,
  readCodexSharedOpenWork
} from './codex-shared-server-open-work'
import { CodexSharedServerRequests } from './codex-shared-server-requests'

/** What the keep side reads of its server. */
export type CodexKeptServer = {
  readonly leases: Set<CodexSharedServerLease>
  readonly router: CodexSharedServerRouter
  readonly physicalConnection: CodexAppServerConnection | null
  readonly relayed?: { chatKey: string } | undefined
  readonly exited: boolean
  /** Re-judges the server once a chat left. */
  ended: () => void
  stop: () => Promise<boolean>
}

/**
 * A relayed shared server's side that outlives this app. Codex holds every chat's history, so the
 * app keeps no copy of the server's output: it acks each line as it reads it, and a chat that
 * reopens rebuilds from Codex (thread/resume). Quit hands each keepable chat's part to the daemon,
 * ending nothing; the server goes on once no chat on it is still open here, with the open work
 * Codex reports, and acks held from the first status read until the detach, so the daemon counts
 * every start and end that read can't see.
 */
export class CodexSharedServerKeep implements CodexSharedLeaseRelay, CodexSharedRelayAcks {
  private handedOff = false
  /** From a hand-off's first status read: no ack, so the daemon replays every later line's work. */
  private fenced = false
  /** Handed to its daemon while the app runs: held requests wait there, never answered here. */
  toDaemon = false
  /** The server process's start time, for its chats' run exit proof; undefined when unread. */
  serverStartTimeMs: number | undefined
  /** Requests Codex waits on (a thread's wait for its chat). */
  readonly requests = new CodexSharedServerRequests()
  /** Chats whose close here proved their part ended (until one opens here again): their run is
   *  over though the server runs on for others. */
  readonly endedChats = new Set<string>()

  /** Every metadata read on this server (hand-offs, close's turn reads) shares these permits. */
  private readonly readPermits = new PrioritySemaphore(CODEX_SHARED_METADATA_READS)

  constructor(private readonly server: CodexKeptServer) {}

  /** The server's connection with its reads limited to four at once, across every caller. */
  limited(connection: CodexAppServerConnection): Pick<CodexAppServerConnection, 'request'> {
    return {
      request: async (method, params, options) => {
        const release = await this.readPermits.acquire(0)
        try {
          return await connection.request(method, params, options)
        } finally {
          release()
        }
      }
    }
  }

  /** Nothing is held back from the ack: Codex has every chat's content. */
  floor = (): number | null => null

  /** False while a hand-off is fenced, which holds the ack where it was. */
  durable = async (): Promise<boolean> => !this.fenced

  async detachForQuit(lease: CodexSharedServerLease): Promise<void> {
    if (lease.handedOff || !this.server.leases.has(lease)) {
      return
    }
    // Nothing more is dispatched to it; its run goes on under the daemon.
    lease.handedOff = true
    lease.unregister()
    this.settleQuit()
  }

  leftQuietly(lease: CodexSharedServerLease): void {
    this.server.router.leave(lease)
    this.server.leases.delete(lease)
    this.server.ended()
  }

  /** Quit: once no chat here is still open on it, the server goes to the daemon or stops. */
  settleQuit(): void {
    const { server } = this
    if (!providerRelayQuitting() || this.handedOff || server.exited) {
      return
    }
    const leases = [...server.leases]
    if (leases.some((lease) => !lease.handedOff)) {
      return
    }
    this.handedOff = true
    // A reattached server may run kept work of chats not open here: it goes on too.
    if (leases.length > 0 || server.physicalConnection?.relay?.reattached === true) {
      const chatKey = server.relayed?.chatKey ?? ''
      trackProviderRelayQuitWork(
        this.fencedOpenWork().then((open) => detachProviderRelayForQuit(chatKey, open))
      )
    } else {
      trackProviderRelayQuitWork(server.stop())
    }
  }

  /**
   * No chat here is open on it, and Codex reports work still open (or can't say): it goes back to
   * its daemon, which idle-stops it once that work ends. Requests wait there, never answered here.
   * False when it couldn't be handed back.
   */
  async handToDaemon(): Promise<boolean> {
    this.toDaemon = true
    const open = await this.fencedOpenWork()
    const handed = await detachProviderRelayToDaemon(this.server.relayed?.chatKey ?? '', () => open)
    this.toDaemon = handed
    this.fenced &&= !handed
    return handed
  }

  /** Whether Codex reports nothing open on the server (false when it can't say). */
  async idle(): Promise<boolean> {
    const connection = this.server.physicalConnection
    if (!connection || connection.closed) {
      return false
    }
    const open = await readCodexSharedOpenWork(this.limited(connection))
    return open !== null && Object.values(open).every((keys) => keys.length === 0)
  }

  /** The open work for a detach, with the ack held from before the first read. */
  private async fencedOpenWork(): Promise<Record<string, string[][]> | null> {
    this.fenced = true
    const connection = this.server.physicalConnection
    if (!connection || connection.closed) {
      return null
    }
    return readCodexSharedOpenWork(this.limited(connection))
  }
}
