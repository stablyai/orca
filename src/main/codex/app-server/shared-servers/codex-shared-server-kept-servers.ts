import {
  KeptProviderRelayUnreachableError,
  setProviderRelayRunPlacement,
  takeProviderRelayRunPlacement,
  type KeptProviderRelay
} from '../../../provider-relay/app-provider-relays'
import { CodexSharedServer } from './codex-shared-server'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import type { CodexSharedServerProcessSweep } from './codex-shared-server-chat-workload'
import {
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
  /** Hand-backs under way; an open of one of their chats waits, then reattaches. */
  private readonly handing = new Map<string, Promise<boolean>>()

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

  /** Whether the chat may still have a part on this relay's server: false only once a chat's close
   *  here proved its part ended. True when no server here is on the relay (its daemon decides). */
  holds(sessionId: string, relayId: string): boolean {
    const server = this.byRelay.get(relayId)
    return !server || server.exited || !server.keep.endedChats.has(sessionId)
  }

  /** The kept server this chat's run is on, attached once for all its chats; null for a new run. */
  async serverFor(
    sessionId: string,
    run: CodexPooledRun,
    spec: CodexSharedServer['spec']
  ): Promise<CodexSharedServer | null> {
    await this.handing.get(run.relayId)
    let server = this.byRelay.get(run.relayId)
    if (server && !server.exited && server.keep.endedChats.has(sessionId)) {
      // Its part here was proven over: its next run is a new one.
      return null
    }
    if (!server || server.exited) {
      const relay = await codexPooledRunGate(sessionId)
      if (!relay) {
        // Its daemon ended it: the chat opens fresh and catches up from Codex's history.
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
    return server
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
        { chatKey: relay.info.chatKey, attach: relay }
      )
    )
    // Started under an older launch (an updated Codex): it serves the chats it kept, no new ones.
    server.draining = key !== spec.key
    this.placements.set(server, { relayId: run.relayId, daemon: run.daemon })
    return server
  }

  /** No chat here is open on this kept server: it goes back to its daemon with the open work Codex
   *  reported. False when it couldn't. */
  handBack(server: CodexSharedServer, open: Record<string, string[][]> | null): Promise<boolean> {
    const relayId = this.placements.get(server)?.relayId
    this.forget(server)
    const handing = server.keep.handToDaemon(open)
    if (relayId) {
      this.handing.set(relayId, handing)
      void handing.finally(() => this.handing.delete(relayId))
    }
    return handing
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
      const startedAt = server.keep.serverStartTimeMs
      setProviderRelayRunPlacement(sessionId, {
        ...placement,
        kind: 'relayed',
        workload: lease.id,
        ...(startedAt === undefined ? {} : { agentStartTimeMs: startedAt })
      })
    }
  }
}
