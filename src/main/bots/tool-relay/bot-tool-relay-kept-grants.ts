// The relay's grants with what keeps them across a restart: tokens sealed at rest, and the
// daemon-held fronts agents kept from an earlier run of Orca reach the relay by.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { TOOL_RELAY_FRONT_MAX_PIPES } from '../../daemon/tool-relay-front/daemon-tool-relay-front'
import { forgetKeptSharedToolCallers } from '../../runtime/agent-session/environment/shared-tool-caller-store'
import {
  isStoredRelayGrant,
  RelayGrants,
  type RelayFolders,
  type RelayGrant
} from './bot-tool-relay-grants'
import { ToolRelayFronts } from './bot-tool-relay-fronts'
import { keptGrantOwnerFolders, keptToolGrantsConfig, keptToolGrantsPath } from './kept-tool-grants'
import { RelaySealedEntries } from './relay-sealed-entries'
import { answerCredentialsLocked } from './bot-tool-relay-sign-in-answer'

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

  /** `server`: the relay's HTTP server, listening; a front's connection is served as one made to it. */
  constructor(server: () => Promise<Server | null>) {
    this.fronts = new ToolRelayFronts((socket, port) => {
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
    })
  }

  /**
   * The kept grants, opened once before any is used. Kept only where desktop startup configured
   * them (macOS and Linux); anywhere else every grant ends with the app, as before.
   */
  loaded(): Promise<void> {
    const config = keptToolGrantsConfig()
    if (config && !this.grants.configured) {
      this.grants.configure(
        new RelaySealedEntries(
          keptToolGrantsPath(config.directory),
          isStoredRelayGrant,
          (entry) => entry.owner
        ),
        keptGrantOwnerFolders(config)
      )
    }
    return this.grants.load()
  }

  /**
   * The owner's token at `appOrigin`, or, for a chat's launch (`keepFor`) whose daemon start holds a
   * front and whose token is now sealed at rest, at that front: its agent may outlive the app.
   */
  async grant(
    owner: string,
    folders: RelayFolders,
    appOrigin: () => Promise<string>,
    keepFor: string | undefined
  ): Promise<RelayGrantAnswer> {
    await this.loaded()
    const origin = await appOrigin()
    const token = this.grants.grant(owner, folders)
    const front = keepFor === undefined ? null : await this.fronts.current(keepFor)
    if (front && (await this.grants.keep(owner))) {
      return { origin: front.origin, token, front: front.daemonInstance }
    }
    return { origin, token }
  }

  /** Opens the kept grants, then answers every daemon start's front. */
  async serveFronts(): Promise<void> {
    await this.loaded()
    await this.fronts.serveAll()
  }

  /**
   * A token's grant. A miss retries the kept ones the keychain refused at startup in the background
   * (at most once per 10 s), so a later lookup finds them.
   */
  of(token: string): RelayGrant | undefined {
    const grant = this.grants.of(token)
    if (!grant) {
      void this.grants.unlock(token).catch(() => {})
    }
    return grant
  }

  /**
   * The request's bearer grant, once the kept ones are open. While a kept token the keychain won't
   * open may be it, the call is answered here (`answered`): try again shortly.
   */
  async bearer(req: IncomingMessage, res: ServerResponse): Promise<RelayGrant | 'answered' | null> {
    await this.loaded()
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    const grant = token ? (this.grants.of(token) ?? (await this.grants.unlock(token))) : undefined
    if (grant === 'locked') {
      await answerCredentialsLocked(req, res)
      return 'answered'
    }
    return grant ?? null
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

  /** Some kept token is still waiting for the keychain. */
  anyLocked(): boolean {
    return this.grants.anyLocked
  }

  /** Whether `owner`'s grant is kept in the file (opened or still locked). */
  keeps(owner: string): boolean {
    return this.grants.holds(owner)
  }

  /** The owner's kept chats' callers go durably first, then its own entry, then its tokens. */
  async revoke(owner: string): Promise<void> {
    await this.loaded().catch(() => {})
    try {
      await forgetKeptSharedToolCallers(owner)
    } finally {
      // A caller file that can't be written never keeps the token working.
      await this.grants.revoke(owner)
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
