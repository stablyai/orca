// The relay's grants with what keeps them across an app restart: a chat's launch hands its grant to
// the daemon start whose front its agent's tools reach, and that start holds it in memory for as long
// as the agent's relay runs, then hands it back when a restarted app serves its front.
import type { IncomingMessage, Server } from 'node:http'
import type { Socket } from 'node:net'
import type { DaemonClient } from '../../daemon/transport/client/daemon-client'
import type { ToolRelayFrontKeptRelay } from '../../daemon/protocol/daemon-tool-relay-front-protocol'
import { TOOL_RELAY_FRONT_MAX_PIPES } from '../../daemon/tool-relay-front/daemon-tool-relay-front'
import { stageProviderRelayFrontGrant } from '../../provider-relay/provider-relay-front-pins'
import { providerRelayRoute } from '../../provider-relay/provider-relay-route'
import {
  forgetKeptSharedToolCallers,
  restoreKeptSharedToolCaller
} from '../../runtime/agent-session/environment/shared-tool-process-callers'
import { RelayGrants, type RelayFolders, type RelayGrant } from './bot-tool-relay-grants'
import { ToolRelayFronts } from './bot-tool-relay-fronts'
import { keptGrantOwnerFolders } from './kept-tool-grants'

const REVOKE_TIMEOUT_MS = 5_000

/**
 * The daemon pipes at most `TOOL_RELAY_FRONT_MAX_PIPES` connections per front and can't tell a
 * stream from a call, so the app budgets them: event streams stop short of the cap so calls get a
 * pipe, and everything but cleanup stops short of it so DELETE does. A front's connections close
 * after each answer, so open pipes are the requests counted here.
 */
export const FRONT_STREAM_BUDGET = TOOL_RELAY_FRONT_MAX_PIPES - 64
export const FRONT_OPEN_BUDGET = TOOL_RELAY_FRONT_MAX_PIPES - 16

/** A grant's address and token; `front` names the daemon start whose front the origin is. */
export type RelayGrantAnswer = { origin: string; token: string; front?: string }

export class KeptRelayGrants {
  private readonly grants = new RelayGrants()
  readonly fronts: ToolRelayFronts
  /** Each front connection's front, by port. */
  private readonly frontOf = new WeakMap<Socket, number>()
  private readonly frontCounts = new Map<number, { streams: number; open: number }>()
  /** The first serve of every daemon start: kept agents' tokens are known once it settles. */
  private serving: Promise<void> | null = null

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
      (client, kept) => this.adopt(client, kept)
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
    keepFor: string | undefined
  ): Promise<RelayGrantAnswer> {
    const origin = await appOrigin()
    const token = this.grants.grant(owner, folders)
    const front = keepFor === undefined ? null : await this.fronts.current(keepFor)
    const granted = this.grants.of(token)
    if (!front || !granted || keepFor === undefined) {
      return { origin, token }
    }
    stageProviderRelayFrontGrant(keepFor, front.daemonInstance, {
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

  /** The request's bearer grant, once every daemon start told which tokens its kept agents carry. */
  async bearer(req: IncomingMessage): Promise<RelayGrant | null> {
    await this.serving?.catch(() => {})
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
    try {
      const clients = (await providerRelayRoute()?.all().catch(() => [])) ?? []
      await Promise.all(
        clients
          .filter((client) => client.getDaemonIdentity()?.toolRelayFront)
          .map((client) => revokeOn(client, owner))
      )
    } finally {
      this.grants.revoke(owner)
      forgetKeptSharedToolCallers(owner)
    }
  }

  /**
   * The grants a daemon start holds for the agents it keeps. A deleted bot's are dropped there too;
   * the rest reach their folders as the current config names them.
   */
  private adopt(client: DaemonClient, kept: readonly ToolRelayFrontKeptRelay[]): void {
    for (const relay of kept) {
      for (const grant of relay.grants) {
        const folders = keptGrantOwnerFolders(grant.owner)
        if (folders === null) {
          void revokeOn(client, grant.owner)
          continue
        }
        this.grants.adopt(grant.owner, grant.token, folders ?? grant.folders)
      }
      const caller = relay.caller
      if (caller && keptGrantOwnerFolders(caller.owner) !== null) {
        restoreKeptSharedToolCaller(relay.chatKey, caller)
      }
    }
  }

  /**
   * A Host the relay answers: its own port, or a daemon-held front it serves. A front's connection
   * closes after each answer: the daemon holds a pipe for every open connection, and an idle
   * keep-alive one would hold a pipe no budget here counts, so cleanup's reserve could fill.
   */
  answers(
    req: Pick<IncomingMessage, 'headers' | 'socket'>,
    res: { shouldKeepAlive: boolean },
    ownPort: number
  ): boolean {
    if (this.frontOf.has(req.socket)) {
      res.shouldKeepAlive = false
    }
    const match = /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(req.headers.host ?? '')
    const port = match ? Number(match[1]) : null
    return port !== null && (port === ownPort || this.fronts.serves(port))
  }

  close(): void {
    this.fronts.close()
    this.grants.clear()
  }
}

/** One daemon start drops the owner's kept grants; one that can't answer drops them as its agents end. */
function revokeOn(client: DaemonClient, owner: string): Promise<void> {
  return client
    .request('toolRelayFrontRevoke', { owner }, REVOKE_TIMEOUT_MS)
    .then(() => {})
    .catch(() => {})
}
