import {
  KeptProviderRelayUnreachableError,
  setProviderRelayRunPlacement,
  takeProviderRelayRunPlacement,
  type KeptProviderRelay
} from '../../../provider-relay/app-provider-relays'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { CodexSharedServer } from './codex-shared-server'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import type { CodexSharedServerProcessSweep } from './codex-shared-server-chat-workload'
import type { CodexRecoveredChat } from './codex-shared-recovery-group'
import {
  codexDeletedPooledRelay,
  codexExpectedChats,
  codexRecordPooledRun,
  codexPooledRunGate,
  codexSharedRelayServerKey,
  type CodexPooledRun,
  type CodexPooledServerPlacement
} from './codex-shared-server-kept-runs'

/** What the kept side needs from the pool that owns every server. */
type PoolHost = {
  track: (server: CodexSharedServer) => CodexSharedServer
  freed: (server: CodexSharedServer) => void
  sweep: () => CodexSharedServerProcessSweep | undefined
}

/** A pool's relayed servers by relay: where each runs, and the kept one a chat's run is on. */
export class CodexKeptServers {
  private readonly byRelay = new Map<string, CodexSharedServer>()
  private readonly placements = new WeakMap<CodexSharedServer, CodexPooledServerPlacement>()

  constructor(private readonly host: PoolHost) {}

  /** A reattached server is found by its relay from the start. */
  noteAttached(server: CodexSharedServer): void {
    const relayId = server.relayed?.attach?.info.relayId
    if (relayId) {
      this.byRelay.set(relayId, server)
    }
  }

  forget(server: CodexSharedServer): void {
    for (const [relayId, held] of this.byRelay) {
      if (held === server) {
        this.byRelay.delete(relayId)
      }
    }
  }

  /** A chat no longer wants its part: each server attached here lets it go. */
  dropped(chatKey: string, relay: KeptProviderRelay | null): void {
    for (const server of relay ? [this.byRelay.get(relay.info.relayId)] : this.byRelay.values()) {
      void server?.keep.releaseExpected(chatKey)
    }
  }

  /** The kept server this chat's run is on, attached once for all its chats; null for a new run. */
  async serverFor(
    sessionId: string,
    run: CodexPooledRun,
    spec: CodexSharedServer['spec']
  ): Promise<{ server: CodexSharedServer; chat: CodexRecoveredChat } | null> {
    let server = this.byRelay.get(run.relayId)
    if (!server || server.exited) {
      const relay = await codexPooledRunGate(sessionId)
      if (!relay) {
        return null
      }
      server = this.byRelay.get(run.relayId) ?? this.reattachServer(spec, relay, run)
    }
    try {
      await server.ready
    } catch {
      // Still kept by its daemon start, maybe: never a second writer beside it.
      throw new KeptProviderRelayUnreachableError(sessionId)
    }
    // Never on the open's own path: a slow server would hold every reopen.
    void server.keep.retryUnresolved()
    const chat = server.recovery.expected(sessionId)
    return chat ? { server, chat } : null
  }

  /**
   * Before a chat is deleted: its part of the kept server its last run is on ends under its tag,
   * once that server is attached (by this ask, or one already under way). False when that run may
   * still be kept but can't be reached, so the delete waits rather than leave it running.
   */
  async stopDeleted(record: AgentSessionRecord): Promise<boolean> {
    const run = codexRecordPooledRun(record)
    if (!run) {
      return true
    }
    let server = this.byRelay.get(run.relayId)
    if (!server || server.exited) {
      const relay = await codexDeletedPooledRelay(record)
      if (typeof relay === 'string') {
        return relay === 'gone'
      }
      server = this.byRelay.get(run.relayId)
      if (!server || server.exited) {
        const spec = { key: '', launch: { command: '', args: [] }, chatEnv: {} }
        server = this.reattachServer(spec, relay, run)
        server.draining = true
      }
    }
    try {
      await server.ready
    } catch {
      return false
    }
    await server.keep.releaseExpected(record.sessionId)
    return true
  }

  private reattachServer(
    spec: CodexSharedServer['spec'],
    relay: KeptProviderRelay,
    run: CodexPooledRun
  ): CodexSharedServer {
    const key = codexSharedRelayServerKey(relay.info.chatKey) ?? spec.key
    const server = this.host.track(
      new CodexSharedServer(
        { ...spec, key },
        (freed) => this.host.freed(freed),
        undefined,
        this.host.sweep(),
        {
          chatKey: relay.info.chatKey,
          attach: relay,
          expected: codexExpectedChats(run.relayId)
        }
      )
    )
    // Started under an older launch (an updated Codex): it serves the chats it kept, no new ones.
    server.draining = key !== spec.key
    this.placements.set(server, { relayId: run.relayId, daemon: run.daemon })
    return server
  }

  /** A relayed server's chat runs there too, under its own tag; any other run ends with this app. */
  placeRun(sessionId: string, server: CodexSharedServer, lease: CodexSharedServerLease) {
    let placement = this.placements.get(server)
    if (!placement && server.relay) {
      const taken = takeProviderRelayRunPlacement(server.relayed?.chatKey ?? '')
      placement = taken.kind === 'relayed' ? taken : undefined
      if (placement) {
        this.placements.set(server, placement)
        this.byRelay.set(placement.relayId, server)
      }
    }
    if (placement && server.relay && lease.keepable) {
      setProviderRelayRunPlacement(sessionId, { ...placement, kind: 'relayed', workload: lease.id })
    }
  }
}
