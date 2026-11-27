// The relay's grants with what keeps them across a restart: tokens sealed at rest, and the
// daemon-held fronts agents kept from an earlier run of Orca reach the relay by.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { forgetKeptSharedToolCallers } from '../../runtime/agent-session/environment/shared-tool-caller-store'
import {
  isStoredRelayGrant,
  RelayGrants,
  type RelayFolders,
  type RelayGrant
} from './bot-tool-relay-grants'
import { ToolRelayFronts } from './bot-tool-relay-fronts'
import { keptGrantOwnerFolders, keptToolGrantsConfig, keptToolGrantsPath } from './kept-tool-grants'
import { RelaySealedFile } from './relay-sealed-file'
import { answerCredentialsLocked } from './bot-tool-relay-sign-in-answer'

/** A grant's address and token; `front` names the daemon start whose front the origin is. */
export type RelayGrantAnswer = { origin: string; token: string; front?: string }

export class KeptRelayGrants {
  private readonly grants = new RelayGrants()
  readonly fronts: ToolRelayFronts

  /** `server`: the relay's HTTP server, listening; a front's connection is served as one made to it. */
  constructor(server: () => Promise<Server | null>) {
    this.fronts = new ToolRelayFronts((socket) => {
      server().then(
        (listening) => (listening ? listening.emit('connection', socket) : socket.destroy()),
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
        new RelaySealedFile(keptToolGrantsPath(config.directory), isStoredRelayGrant),
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

  of(token: string): RelayGrant | undefined {
    return this.grants.of(token)
  }

  /**
   * The request's bearer grant, once the kept ones are open. While a kept token the keychain won't
   * open may be it, the call is answered here (`answered`): try again shortly.
   */
  async bearer(req: IncomingMessage, res: ServerResponse): Promise<RelayGrant | 'answered' | null> {
    await this.loaded()
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    const grant = token ? (this.grants.of(token) ?? this.grants.unlock(token)) : undefined
    if (grant === 'locked') {
      await answerCredentialsLocked(req, res)
      return 'answered'
    }
    return grant ?? null
  }

  /** Whether `owner`'s grant is kept in the file (opened or still locked). */
  keeps(owner: string): boolean {
    return this.grants.holds(owner)
  }

  /** The owner's kept chats' callers go durably first, then its own entry, then its tokens. */
  async revoke(owner: string): Promise<void> {
    await this.loaded().catch(() => {})
    await forgetKeptSharedToolCallers(owner)
    await this.grants.revoke(owner)
  }

  /** A Host the relay answers: its own port, or a daemon-held front it serves. */
  answers(host: string | undefined, ownPort: number): boolean {
    const match = /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(host ?? '')
    const port = match ? Number(match[1]) : null
    return port !== null && (port === ownPort || this.fronts.serves(port))
  }

  close(): void {
    this.fronts.close()
    this.grants.clear()
  }
}
