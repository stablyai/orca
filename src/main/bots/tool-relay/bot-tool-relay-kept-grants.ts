// The relay's grants with what keeps them across an app restart: a chat's launch hands its grant to
// the daemon start whose front its agent's tools reach, and that start holds it in memory for as long
// as the agent's relay runs, then hands it back when a restarted app serves its front.
import type { IncomingMessage, Server } from 'node:http'
import type { Socket } from 'node:net'
import { BoundedMap } from '../../../shared/collections/bounded-map'
import type { DaemonClient } from '../../daemon/transport/client/daemon-client'
import type { ToolRelayFrontKeptRelay } from '../../daemon/protocol/daemon-tool-relay-front-protocol'
import { TOOL_RELAY_FRONT_MAX_PIPES } from '../../daemon/tool-relay-front/daemon-tool-relay-front'
import { stageProviderRelayFrontGrant } from '../../provider-relay/provider-relay-front-pins'
import { providerRelayRoute } from '../../provider-relay/provider-relay-route'
import {
  forgetKeptSharedToolCallers,
  forgetKeptSharedToolChat,
  restoreKeptSharedToolCaller
} from '../../runtime/agent-session/environment/shared-tool-process-callers'
import { RelayGrants, type RelayFolders, type RelayGrant } from './bot-tool-relay-grants'
import { ToolRelayFronts, type ToolRelayKeep } from './bot-tool-relay-fronts'
import { keptGrantOwnerFolders } from './kept-tool-grants'

const REVOKE_TIMEOUT_MS = 5_000

/**
 * The daemon pipes at most `TOOL_RELAY_FRONT_MAX_PIPES` connections per front and can't tell a
 * stream from a call, so the app budgets them: event streams stop short of the cap so calls get a
 * pipe, and everything but cleanup stops short of it so DELETE does. A front's connections close
 * after each answer, so open pipes are the requests counted here.
 */
export const FRONT_STREAM_BUDGET = TOOL_RELAY_FRONT_MAX_PIPES - 32
export const FRONT_OPEN_BUDGET = TOOL_RELAY_FRONT_MAX_PIPES - 8

/** A grant's address and token; `front` names the daemon start whose front the origin is. */
export type RelayGrantAnswer = { origin: string; token: string; front?: string }

type AdoptedRelay = {
  chatKey: string
  grants: { owner: string; token: string }[]
  caller?: { owner: string; token: string }
}
type AdoptedRelays = { relays: Map<string, AdoptedRelay>; holders: Map<string, number> }

export class KeptRelayGrants {
  private readonly grants = new RelayGrants()
  readonly fronts: ToolRelayFronts
  /** Each front connection's front, by port. */
  private readonly frontOf = new WeakMap<Socket, number>()
  private readonly frontCounts = new Map<number, { streams: number; open: number }>()
  /** Serving every daemon start's front at startup, asked once per run. */
  private serving: Promise<void> | null = null
  /** What each daemon start last handed back, by relay, with how many of its relays hold each token. */
  private readonly adopted = new Map<DaemonClient, AdoptedRelays>()
  /** Owners revoked this run (deleted bots): a serve before the config drops them adopts none. */
  private readonly revoked = new BoundedMap<string, true>({ maxEntries: 256 })

  /** `server`: the relay's HTTP server, listening; a front's connection is served as one made to it. */
  constructor(server: () => Promise<Server | null>) {
    this.fronts = new ToolRelayFronts(
      (socket, port) => {
        this.cameThroughFront(socket, port)
        server().then(
          (listening) => {
            if (!listening || this.fronts.isClosed) {
              socket.destroy()
              return
            }
            listening.emit('connection', socket)
            // The hello left it paused, with any request bytes already read put back.
            socket.resume()
          },
          () => socket.destroy()
        )
      },
      (client, kept) => this.adopt(client, kept),
      (client, relayId) => this.keptEnded(client, relayId)
    )
  }

  /**
   * The owner's token at `appOrigin`, or, for a chat's launch (`keepFor`) whose daemon start holds a
   * front, at that front: the grant goes with the agent's spawn to that start, which holds it for as
   * long as the agent runs, so the agent may outlive the app.
   */
  async grant(
    owner: string,
    folders: RelayFolders,
    appOrigin: () => Promise<string>,
    keepFor: ToolRelayKeep | undefined
  ): Promise<RelayGrantAnswer> {
    const origin = await appOrigin()
    const token = this.grants.grant(owner, folders)
    const front = keepFor === undefined ? null : await this.fronts.current(keepFor)
    const granted = this.grants.of(token)
    if (!front || !granted || keepFor === undefined) {
      return { origin, token }
    }
    stageProviderRelayFrontGrant(keepFor.chatKey, front.daemonInstance, {
      owner,
      token,
      folders: granted.folders
    })
    return { origin: front.origin, token, front: front.daemonInstance }
  }

  /** Answers every daemon start's front, learning the tokens of the agents each one keeps. */
  serveFronts(): Promise<void> {
    this.serving ??= this.fronts.serveAll()
    return this.serving
  }

  of(token: string): RelayGrant | undefined {
    return this.grants.of(token)
  }

  /**
   * The request's bearer grant. One through a front waits until that front's daemon start told
   * which tokens its kept agents carry; one to the app's own port never waits.
   */
  async bearer(req: IncomingMessage): Promise<RelayGrant | null> {
    const port = this.frontOf.get(req.socket)
    if (port !== undefined) {
      await this.fronts.servedAt(port)?.catch(() => {})
    }
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    return (token ? this.grants.of(token) : undefined) ?? null
  }

  /**
   * Admits a call by `admit`. Through a front, a GET stream also needs one of the front's stream
   * slots, and anything but cleanup leaves the cleanup reserve free, until its response ends.
   * Refused, its connection closes, so its daemon pipe frees now.
   */
  admitThroughFront<Call>(
    req: Pick<IncomingMessage, 'method' | 'socket'>,
    res: { shouldKeepAlive: boolean; once(event: 'close', listener: () => void): unknown },
    admit: () => Call | null
  ): Call | null {
    const port = this.frontOf.get(req.socket)
    if (port === undefined) {
      return admit()
    }
    const counts = this.frontCounts.get(port) ?? { streams: 0, open: 0 }
    const stream = req.method === 'GET'
    const fits =
      req.method === 'DELETE' ||
      (counts.open < FRONT_OPEN_BUDGET && (!stream || counts.streams < FRONT_STREAM_BUDGET))
    const call = fits ? admit() : null
    if (!call) {
      res.shouldKeepAlive = false
      return null
    }
    counts.open += 1
    counts.streams += stream ? 1 : 0
    this.frontCounts.set(port, counts)
    res.once('close', () => {
      counts.open -= 1
      counts.streams -= stream ? 1 : 0
      if (counts.open === 0) {
        this.frontCounts.delete(port)
      }
    })
    return call
  }

  /** A connection a front handed over: its requests count against that front's budget. */
  cameThroughFront(socket: Socket, port: number | null): void {
    if (port !== null) {
      this.frontOf.set(socket, port)
    }
  }

  /**
   * The owner's token stops working: every daemon start drops the owner's grants and callers first
   * (so no restarted app takes them back), then this run forgets them.
   */
  async revoke(owner: string): Promise<void> {
    this.revoked.set(owner, true)
    try {
      const clients =
        (await providerRelayRoute()
          ?.all()
          .catch(() => [])) ?? []
      await Promise.all(
        clients
          .filter((client) => client.getDaemonIdentity()?.toolRelayFront)
          .map((client) => revokeOn(client, owner))
      )
    } finally {
      this.grants.revoke(owner)
      forgetKeptSharedToolCallers(owner)
      for (const adopted of this.adopted.values()) {
        retireOwner(adopted, owner)
      }
    }
  }

  /**
   * The grants a daemon start holds for the agents it keeps. A deleted bot's are dropped there too;
   * the rest reach their folders as the current config names them.
   */
  adopt(client: DaemonClient, kept: readonly ToolRelayFrontKeptRelay[]): void {
    const configured = keptGrantOwnerFolders()
    const ownerFolders = (owner: string) => {
      const folders = configured(owner)
      // Gone from the config, the bot needs no tombstone.
      if (folders === null) {
        this.revoked.delete(owner)
      }
      return this.revoked.has(owner) ? null : folders
    }
    const revoked = new Set<string>()
    const earlier = this.adopted.get(client)
    const now: AdoptedRelays = { relays: new Map(), holders: new Map() }
    this.adopted.set(client, now)
    for (const relay of kept) {
      const held: AdoptedRelay = { chatKey: relay.chatKey, grants: [] }
      for (const grant of relay.grants) {
        const folders = ownerFolders(grant.owner)
        if (folders === null) {
          if (!revoked.has(grant.owner)) {
            revoked.add(grant.owner)
            void revokeOn(client, grant.owner)
          }
          continue
        }
        held.grants.push({ owner: grant.owner, token: grant.token })
        now.holders.set(grant.token, (now.holders.get(grant.token) ?? 0) + 1)
        this.grants.adopt(grant.owner, grant.token, folders ?? grant.folders)
      }
      const caller = relay.caller
      if (caller && ownerFolders(caller.owner) !== null) {
        restoreKeptSharedToolCaller(relay.chatKey, caller)
        held.caller = { owner: caller.owner, token: caller.token }
      }
      now.relays.set(relay.relayId, held)
    }
    // What this start no longer holds (its agents ended) goes, unless another start holds it.
    const callers = new Map([...now.relays.values()].map((relay) => [relay.chatKey, relay]))
    for (const relay of earlier?.relays.values() ?? []) {
      const token = relay.caller?.token
      if (token !== undefined && callers.get(relay.chatKey)?.caller?.token !== token) {
        forgetKeptSharedToolChat(relay.chatKey, token)
      }
    }
    for (const token of earlier?.holders.keys() ?? []) {
      this.forgetUnheld(token)
    }
  }

  /** A relay that daemon start kept ended: only its agent's tokens and caller go. */
  keptEnded(client: DaemonClient, relayId: string): void {
    const adopted = this.adopted.get(client)
    const relay = adopted?.relays.get(relayId)
    if (!adopted || !relay) {
      return
    }
    adopted.relays.delete(relayId)
    if (relay.caller) {
      forgetKeptSharedToolChat(relay.chatKey, relay.caller.token)
    }
    for (const { token } of relay.grants) {
      if (release(adopted, token)) {
        this.forgetUnheld(token)
      }
    }
  }

  private forgetUnheld(token: string): void {
    for (const adopted of this.adopted.values()) {
      if (adopted.holders.has(token)) {
        return
      }
    }
    this.grants.forget(token)
  }

  /**
   * A Host the relay answers: its own port, or a daemon-held front it serves. A front's connection
   * closes after each answer: the daemon holds a pipe for every open connection, and an idle
   * keep-alive one would hold a pipe no budget here counts, so cleanup's reserve could fill.
   */
  answers(
    req: Pick<IncomingMessage, 'headers' | 'socket'>,
    res: { shouldKeepAlive: boolean; once(event: 'finish', listener: () => void): unknown },
    ownPort: number
  ): boolean {
    if (this.frontOf.has(req.socket)) {
      res.shouldKeepAlive = false
      // A handler's own `Connection: keep-alive` (an SDK's event stream) turns keep-alive back on.
      res.once('finish', () => req.socket.end())
    }
    const match = /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(req.headers.host ?? '')
    const port = match ? Number(match[1]) : null
    return port !== null && (port === ownPort || this.fronts.serves(port))
  }

  close(): void {
    this.fronts.close()
    this.grants.clear()
    this.adopted.clear()
  }
}

/** One fewer relay holds the token; true when none does any more. */
function release(adopted: AdoptedRelays, token: string): boolean {
  const count = (adopted.holders.get(token) ?? 1) - 1
  if (count > 0) {
    adopted.holders.set(token, count)
    return false
  }
  adopted.holders.delete(token)
  return true
}

/** A revoked owner's grants and callers leave this start's records (the app already ended them). */
function retireOwner(adopted: AdoptedRelays, owner: string): void {
  for (const [relayId, relay] of adopted.relays) {
    for (const { token } of relay.grants.filter((grant) => grant.owner === owner)) {
      release(adopted, token)
    }
    relay.grants = relay.grants.filter((grant) => grant.owner !== owner)
    if (relay.caller?.owner === owner) {
      delete relay.caller
    }
    if (relay.grants.length === 0 && !relay.caller) {
      adopted.relays.delete(relayId)
    }
  }
}

/** One daemon start drops the owner's kept grants; one that can't answer drops them as its agents end. */
function revokeOn(client: DaemonClient, owner: string): Promise<void> {
  return client
    .request('toolRelayFrontRevoke', { owner }, REVOKE_TIMEOUT_MS)
    .then(() => {})
    .catch(() => {})
}
