import type { z } from 'zod'
import {
  requestConnector,
  type ConnectorRequest,
  type ConnectorResult
} from './connector-cloud-request'

// Renew early so a token cannot lapse between the check and the request.
const TOKEN_RENEWAL_MARGIN_MS = 60_000

export type ConnectorToken = { connectorToken: string; expiresAt: number }

/** Asks Orca's auth service for a short-lived connector token as this machine's signed-in account. */
export type ConnectorTokenMint = () => Promise<ConnectorResult<ConnectorToken>>

/**
 * Watches one call for diagnostics: the call's own lifetime (it can wait on a token mint or renewal
 * between requests) and each HTTP request it actually sends. Changes nothing about the call.
 */
export type ConnectorCallObserver = {
  callStarted(): void
  callSettled(): void
  /** `renewal`: the second request, after a 401 and a fresh token. */
  requestStarted(renewal: boolean): void
  requestSettled(status: number | 'network' | 'aborted'): void
  /** The call sent nothing more because no token could be minted. */
  noRequest(reason: 'token'): void
}

export type ConnectorCallOptions = Pick<ConnectorRequest, 'method' | 'timeoutMs' | 'signal'> & {
  requests?: ConnectorCallObserver | undefined
}

/** Calls to the connector with a connector token, the way the relay is reached with relay tokens. */
export class ConnectorAccountTransport {
  private token: ConnectorToken | null = null
  private pending: Promise<ConnectorResult<ConnectorToken>> | null = null

  constructor(
    private readonly origin: string,
    private readonly mint: ConnectorTokenMint,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly now: () => number = Date.now
  ) {}

  /** An authorized call; a 401 mints one new token and tries once more. */
  async call<TSchema extends z.ZodType>(
    path: string,
    body: unknown,
    schema: TSchema,
    options: ConnectorCallOptions = {}
  ): Promise<ConnectorResult<z.infer<TSchema>>> {
    const { requests } = options
    requests?.callStarted()
    try {
      const token = await this.ensure()
      if (!token.ok) {
        requests?.noRequest('token')
        return token
      }
      const result = await this.send(token.value, path, body, schema, options, false)
      if (result.ok || result.status !== 401) {
        return result
      }
      // Drop only the refused token; a concurrent call may already hold its replacement.
      if (this.token === token.value) {
        this.token = null
      }
      const renewed = await this.ensure()
      if (!renewed.ok) {
        requests?.noRequest('token')
        return renewed
      }
      return await this.send(renewed.value, path, body, schema, options, true)
    } finally {
      requests?.callSettled()
    }
  }

  private async send<TSchema extends z.ZodType>(
    token: ConnectorToken,
    path: string,
    body: unknown,
    schema: TSchema,
    { requests, ...options }: ConnectorCallOptions,
    renewal: boolean
  ): Promise<ConnectorResult<z.infer<TSchema>>> {
    const url = `${this.origin}${path}`
    // Counted here: requestConnector makes exactly one fetch.
    requests?.requestStarted(renewal)
    let settled: number | 'network' | 'aborted' = 'network'
    const fetchImpl: typeof globalThis.fetch = requests
      ? async (input, init) => {
          try {
            const response = await this.fetchImpl(input, init)
            settled = response.status
            return response
          } catch (error) {
            settled = init?.signal?.aborted ? 'aborted' : 'network'
            throw error
          }
        }
      : this.fetchImpl
    try {
      return await requestConnector(
        { ...options, fetchImpl, url, body, token: token.connectorToken },
        schema
      )
    } finally {
      requests?.requestSettled(settled)
    }
  }

  private async ensure(): Promise<ConnectorResult<ConnectorToken>> {
    const cached = this.token
    if (cached && cached.expiresAt - TOKEN_RENEWAL_MARGIN_MS > this.now()) {
      return { ok: true, value: cached }
    }
    // Concurrent calls share one mint.
    this.pending ??= this.mint()
      .then((minted) => {
        if (minted.ok) {
          this.token = minted.value
        }
        return minted
      })
      .finally(() => {
        this.pending = null
      })
    return await this.pending
  }
}
