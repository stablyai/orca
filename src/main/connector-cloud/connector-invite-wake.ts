// The invite wake: the connector's wake socket, dialed with the sign-in's own wake token by a desktop
// that runs no connector, so the share list is read when the cloud says it changed instead of polled.
// It also routes each share-list read: as the sign-in itself while it may hold this socket.
import type { z } from 'zod'
import {
  CONNECTOR_WAKE_CLOSE_CODE,
  ConnectorWakeOfferSchema
} from '../../../cloud/packages/connector-contract/src/wake-messages'
import type { OrcaCloudWakeToken } from '../orca-profiles/cloud-session/profile-cloud-session-exchange'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'
import {
  requestConnector,
  SIGNED_OUT,
  UNREADABLE_ANSWER,
  type ConnectorResult
} from './connector-cloud-request'
import { ConnectorWakeChannel } from './connector-wake-channel'
import type { ConnectorWakeTokenResult } from './connector-transport'
import type { ConnectorWakeSocketFactory } from './connector-wake-socket'

// On a share-list answer only while this desktop is in the cloud's rollout; absent, no socket.
const WAKE_URL_HEADER = 'x-orca-wake-url'
const MACHINE_ID_HEADER = 'x-orca-machine-id'

export type InviteWakeEvent = 'opened' | 'closed' | 'shares-changed'

/** The sign-in's own way to the share list, and its wake token. */
export type InviteWakeSignIn = {
  call: SignInCall
  /** This install's id, the one connector tokens are minted for. */
  machineId: () => Promise<string>
  /** The session's wake token, after its usual refresh when its access token is about to expire. */
  freshWakeToken: () => Promise<OrcaCloudWakeToken | null>
}

export type ShareReadOptions = { timeoutMs?: number; signal?: AbortSignal }

export type ShareRead = <TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  options?: ShareReadOptions
) => Promise<ConnectorResult<z.infer<TSchema>>>

export type InviteWakeDeps = {
  /** Absent on a host that reads shares only as a connector. */
  signIn?: InviteWakeSignIn
  /** The read with a connector token, as before. */
  connectorRead: ShareRead
  /** The account reads are made as; null signed out or quitting. */
  account: () => string | null
  /** A connector runs or is wanted: its own socket names the same wake object, so this one stays
   *  shut. */
  connectorHolds: () => boolean
  origin: string
  fetchImpl?: typeof globalThis.fetch
  random?: () => number
  wakeSocketFactory?: ConnectorWakeSocketFactory
  now?: () => number
}

export class InviteWake {
  private readonly channel: ConnectorWakeChannel
  private readonly listeners = new Set<(event: InviteWakeEvent) => void>()
  // What the channel was last offered; the same URL and token never dial again (a refused socket
  // waits for the next refresh).
  private offered: { url: string; token: string } | null = null
  private dialed: string | null = null
  // The newest wake token the session gave a read or a dial.
  private issued: OrcaCloudWakeToken | null = null
  // Country refused or a frame too big: no socket until the app restarts.
  private halted = false
  private readonly now: () => number

  constructor(private readonly deps: InviteWakeDeps) {
    this.now = deps.now ?? Date.now
    this.channel = new ConnectorWakeChannel({
      token: (renew) => this.dialToken(renew),
      random: deps.random ?? Math.random,
      socketFactory: deps.wakeSocketFactory,
      events: {
        opened: () => this.emit('opened'),
        // Not sent to a desktop without a connector, but it means the same: check the invites.
        wake: () => this.sharesChanged(),
        ended: (end) => {
          if (
            end.code === CONNECTOR_WAKE_CLOSE_CODE.COUNTRY_REFUSED ||
            end.code === CONNECTOR_WAKE_CLOSE_CODE.FRAME_TOO_BIG
          ) {
            this.halted = true
          }
          if (end.opened) {
            this.emit('closed')
          }
        },
        sharesChanged: () => this.sharesChanged()
      }
    })
  }

  /** Whether the socket is open, so the share list needs no idle read. */
  get up(): boolean {
    return this.channel.connected
  }

  /**
   * Reads a shares route as the signed-in account. With a connector running, or an auth service that
   * issued no wake token, with a connector token as before (its reads keep a connector's socket told
   * of share changes); else with the sign-in's own token, whose answer says whether to hold the socket.
   */
  readonly readShares: ShareRead = async (path, schema, options = {}) => {
    const { signIn } = this.deps
    const account = this.deps.account()
    const machineId =
      signIn && account && !this.deps.connectorHolds()
        ? await signIn.machineId().catch(() => null)
        : null
    // The session's usual refresh runs first if due (sending that id), so its wake token is the newest.
    // A refresh that failed just now proves nothing: a token already given still says this cloud
    // issues them.
    const issued =
      machineId && signIn ? await signIn.freshWakeToken().catch(() => this.issued) : null
    if (!signIn || !machineId || !issued) {
      return await this.deps.connectorRead(path, schema, options)
    }
    const { result, wakeUrl } = await readSharesWithSignIn({
      ...options,
      call: signIn.call,
      url: `${this.deps.origin}${path}`,
      machineId,
      schema,
      fetchImpl: this.deps.fetchImpl ?? globalThis.fetch
    })
    if (result.ok && this.deps.account() === account && !this.deps.connectorHolds()) {
      this.issued = issued
      this.offer(wakeUrl)
    }
    return result
  }

  listen(listener: (event: InviteWakeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A wake socket (this one or a connector's) said the account's shares changed. */
  sharesChanged(): void {
    this.emit('shares-changed')
  }

  // Each share-list answer read with the sign-in token: its wake URL header, or null. An open socket
  // outlives its token; only a new URL or a newer token dials.
  private offer(header: string | null): void {
    const url = header === null ? null : ConnectorWakeOfferSchema.shape.wakeUrl.safeParse(header)
    if (!url?.success || this.halted) {
      this.stop()
      return
    }
    const token = this.issued
    if (!token || token.expiresAt <= this.now()) {
      return
    }
    if (this.offered?.url === url.data && this.offered.token === token.token) {
      return
    }
    this.offered = { url: url.data, token: token.token }
    this.channel.offer({ wakeUrl: url.data })
  }

  /** The account changed or its share list said no socket: it closes until offered again. A
   *  connector that starts replaces it from the cloud's side (4409), so it is never redialed. */
  stop(): void {
    const wasUp = this.up
    this.offered = null
    this.issued = null
    this.channel.offer(null)
    if (wasUp) {
      this.emit('closed')
    }
  }

  // A refused token (4401) redials once only with a newer one; none newer waits for the next refresh.
  private async dialToken(renew: boolean): Promise<ConnectorWakeTokenResult> {
    // A connector holds the same wake object with its own socket; signed out or quitting, none.
    if (this.deps.connectorHolds() || !this.deps.account() || !this.deps.signIn) {
      return 'none'
    }
    let token: OrcaCloudWakeToken | null
    try {
      token = await this.deps.signIn.freshWakeToken()
    } catch {
      return 'failed'
    }
    // Refused (4401): only a newer token redials; none newer waits for the next refresh.
    if (!token || token.expiresAt <= this.now() || (renew && token.token === this.dialed)) {
      return 'none'
    }
    this.issued = token
    this.dialed = token.token
    return { token: token.token }
  }

  private emit(event: InviteWakeEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

/** Runs `operation` with the sign-in's access token, refreshing the session once on a 401. */
export type SignInCall = <T>(
  operation: (accessToken: string) => Promise<T>
) => Promise<{ status: 'ok'; value: T } | { status: 'reconnect-required' }>

/** GETs a shares route as the sign-in itself (no connector token), with the answer's wake URL. */
export async function readSharesWithSignIn<TSchema extends z.ZodType>(request: {
  call: SignInCall
  url: string
  machineId: string
  schema: TSchema
  fetchImpl: typeof globalThis.fetch
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<{ result: ConnectorResult<z.infer<TSchema>>; wakeUrl: string | null }> {
  const { call, schema, fetchImpl, machineId, ...rest } = request
  try {
    const outcome = await call(async (accessToken) => {
      let wakeUrl: string | null = null
      const result = await requestConnector(
        {
          ...rest,
          method: 'GET',
          token: accessToken,
          headers: { [MACHINE_ID_HEADER]: machineId },
          fetchImpl: async (input, init) => {
            const response = await fetchImpl(input, init)
            wakeUrl = response.headers.get(WAKE_URL_HEADER)
            return response
          }
        },
        schema
      )
      // `call` refreshes the session and asks once more; a second 401 is the answer.
      if (!result.ok && result.status === 401) {
        throw new OrcaCloudRequestError(401)
      }
      return { result, wakeUrl: result.ok ? wakeUrl : null }
    })
    return outcome.status === 'ok' ? outcome.value : { result: SIGNED_OUT, wakeUrl: null }
  } catch (error) {
    const refused = error instanceof OrcaCloudRequestError && error.statusCode === 401
    return {
      result: refused
        ? { ok: false, status: 401, error: null, retryAfterMs: null }
        : UNREADABLE_ANSWER,
      wakeUrl: null
    }
  }
}
