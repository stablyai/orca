// An in-process Orca Cloud connector speaking the real wire shapes, with tokens minted per account.
import { randomBytes } from 'node:crypto'
import { CONNECTOR_CLIENT_LIMITS, CONNECTOR_PATHS } from '../../shared/connector-cloud-contract'
import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorToken, ConnectorTokenMint } from './connector-transport'

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

const TOKEN_TTL_MS = 5 * 60_000

export class FakeConnectorCloud {
  readonly origin = 'https://connector.test'
  readonly requests: { path: string; body: unknown; token: string | null }[] = []
  /** Forces a status on every request to these paths, e.g. 404 from an older cloud. */
  readonly forced = new Map<string, Reply>()
  online = true
  /** How long a poll answer takes to arrive once it is ready. */
  pollReplyDelayMs = 0
  /** Requests never answer, as on a stalled network. */
  hang = false
  /** Requests to these paths wait for `release(path)`, then are judged against the cloud's state then. */
  readonly holdBefore = new Set<string>()
  /** Requests to these paths take effect at once; their answers wait for `release(path)`. */
  readonly holdAfter = new Set<string>()
  private readonly held = new Map<string, (() => void)[]>()
  /** Accounts the auth service still mints for; removing one is a sign-out elsewhere. */
  readonly signedIn = new Set<string>(['ada'])
  /** Every token minted, in order. */
  readonly minted: { account: string; token: string }[] = []
  private readonly tokens = new Map<string, { account: string; expiresAt: number }>()
  // The hello the cloud keeps, and the highest event batch applied under it.
  private hello: { rev: number; seq: number } | null = null
  // The last revision handed out; it outlives a lost hello, as the host row does.
  private lastRev = 0
  /** Every hello, ack and event the machine sent, in order. */
  readonly hellos: unknown[] = []
  readonly acks: unknown[] = []
  readonly events: unknown[] = []
  /** Poll answers in order; a poll with none queued is held until one is queued. */
  private readonly pollReplies: Reply[] = []
  private heldPoll: (() => void) | null = null

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (!this.online) {
      throw new TypeError('fetch failed')
    }
    if (this.hang) {
      return new Promise<never>(() => {})
    }
    const url = new URL(String(input))
    const path = url.pathname
    if (Buffer.byteLength(String(init?.body ?? '')) > CONNECTOR_CLIENT_LIMITS.maxRequestBytes) {
      return Response.json({ error: 'request_too_large' }, { status: 413 })
    }
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    const auth = new Headers(init?.headers).get('authorization')
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    this.requests.push({ path, body, token })
    if (this.holdBefore.has(path)) {
      await this.waitForRelease(path)
    }
    const reply = this.forced.get(path) ?? (await this.route(path, body, token, init?.signal))
    if (this.holdAfter.has(path)) {
      await this.waitForRelease(path)
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers }
    })
  }

  /** The auth service's connector-token route for one account, minus the HTTP. */
  mintFor(account: string): ConnectorTokenMint {
    return async (): Promise<ConnectorResult<ConnectorToken>> => {
      if (!this.signedIn.has(account)) {
        return { ok: false, status: 401, error: 'signed_out', retryAfterMs: null }
      }
      const connectorToken = randomBytes(16).toString('base64url')
      const expiresAt = Date.now() + TOKEN_TTL_MS
      this.tokens.set(connectorToken, { account, expiresAt })
      this.minted.push({ account, token: connectorToken })
      return { ok: true, value: { connectorToken, expiresAt } }
    }
  }

  requestsTo(path: string): { body: unknown; token: string | null }[] {
    return this.requests.filter((request) => request.path === path)
  }

  /** Answers the next poll; `status` other than 200 is an error reply. */
  answerPoll(reply: Reply): void {
    this.pollReplies.push(reply)
    this.heldPoll?.()
  }

  /** Lets every held request or answer for `path` go on, and stops holding new ones. */
  release(path: string): void {
    this.holdBefore.delete(path)
    this.holdAfter.delete(path)
    for (const resume of this.held.get(path)?.splice(0) ?? []) {
      resume()
    }
  }

  private waitForRelease(path: string): Promise<void> {
    return new Promise((resolve) => {
      const waiting = this.held.get(path) ?? []
      waiting.push(resolve)
      this.held.set(path, waiting)
    })
  }

  /** Refuses every token issued so far, as a key rotation would. */
  refuseTokens(): void {
    this.tokens.clear()
  }

  /** Another hello for this machine lands, as a retired client's late one would. */
  helloFromElsewhere(): void {
    this.hello = { rev: ++this.lastRev, seq: -1 }
  }

  /** Loses the hello, as a cloud restart would; the machine must say it again. */
  forgetHello(): void {
    this.hello = null
  }

  private async route(
    path: string,
    body: unknown,
    token: string | null,
    signal: AbortSignal | null | undefined
  ): Promise<Reply> {
    switch (path) {
      case CONNECTOR_PATHS.hello:
      case CONNECTOR_PATHS.poll:
      case CONNECTOR_PATHS.acks:
      case CONNECTOR_PATHS.events:
        return this.machineCall(path, body, token, signal)
      default:
        return { status: 404, body: { error: 'not_found' } }
    }
  }

  private async machineCall(
    path: string,
    body: unknown,
    token: string | null,
    signal: AbortSignal | null | undefined
  ): Promise<Reply> {
    const issued = token ? this.tokens.get(token) : undefined
    if (!issued || issued.expiresAt <= Date.now()) {
      return { status: 401, body: { error: 'invalid_token' } }
    }
    const fields = isRecord(body) ? body : {}
    const rev = typeof fields.helloRev === 'number' ? fields.helloRev : -1
    if (path === CONNECTOR_PATHS.hello) {
      this.hellos.push(body)
      // Every hello gets the next revision and a fresh event mark.
      this.hello = { rev: ++this.lastRev, seq: -1 }
      return { status: 200, body: { helloRev: this.hello.rev } }
    }
    const { hello } = this
    // Anything under another hello is refused and applies nothing.
    if (!hello || rev !== hello.rev) {
      return { status: 409, body: { error: 'hello_required' } }
    }
    if (path === CONNECTOR_PATHS.acks) {
      this.acks.push(...(Array.isArray(fields.acks) ? fields.acks : []))
      return { status: 204 }
    }
    if (path === CONNECTOR_PATHS.events) {
      // Applied only above this hello's high-water mark; a late or repeated batch is dropped.
      const seq = typeof fields.seq === 'number' ? fields.seq : -1
      if (seq > hello.seq) {
        hello.seq = seq
        this.events.push(...(Array.isArray(fields.events) ? fields.events : []))
      }
      return { status: 204 }
    }
    while (this.pollReplies.length === 0) {
      await new Promise<void>((resolve, reject) => {
        this.heldPoll = resolve
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true
        })
      })
      this.heldPoll = null
    }
    const reply = this.pollReplies.shift() ?? { status: 500 }
    if (this.pollReplyDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.pollReplyDelayMs))
    }
    return reply
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
