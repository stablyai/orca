import { exchangeRelayAuthorization, type RelayAuthorization } from '../director/relay-http-client'
import type { RelayHostCloseReason } from '../../../../shared/remote-runtime/relay/relay-host-close-reason'
import { StaleRelayBrokerError } from './relay-session-broker-contract'
import type { RelaySessionBrokerOptions } from './relay-session-broker-contract'

// The relay-token endpoint on a director-provided authOrigin (AssignmentResponse.authOrigin).
// Session refresh never moves: the refresh token and its answers stay on the configured auth base.
export function relayTokenEndpointAt(authOrigin: string): string {
  return new URL('/v1/desktop/auth/relay-token', `${authOrigin}/`).toString()
}

// The relay-token request got no usable answer from its origin: no response at all, or a 5xx.
export class RelayTokenUnansweredError extends Error {
  constructor(cause: unknown) {
    super('relay_token_unanswered', { cause })
  }
}

// Which origin the next relay-token exchange uses. Without an authOrigin every attempt uses the
// configured endpoint, exactly as before authOrigin existed. With one, each unanswered exchange
// flips to the other origin; any other failure (an answer, a local error) returns to the auth base.
export class RelayRenewalOrigin {
  private viaAuthOrigin = false

  // undefined: the configured relay-token endpoint.
  next(authOrigin: string | undefined): string | undefined {
    return this.viaAuthOrigin && authOrigin ? authOrigin : undefined
  }

  succeeded(): void {
    this.viaAuthOrigin = false
  }

  failed(error: unknown, authOrigin: string | undefined): void {
    this.viaAuthOrigin =
      authOrigin !== undefined && error instanceof RelayTokenUnansweredError && !this.viaAuthOrigin
  }
}

// One renewal attempt: a fresh access token from the configured auth base, then a relay token from
// `authOrigin` (or the configured endpoint). 'refused': the account can no longer hold the relay.
export type RelayRenewal =
  | { kind: 'renewed'; authorization: RelayAuthorization }
  | { kind: 'refused'; hostCloseReason?: RelayHostCloseReason }

export async function renewRelayAuthorization(
  options: Pick<
    RelaySessionBrokerOptions,
    'authConfig' | 'refreshAccessToken' | 'keypair' | 'fetch' | 'isCurrent'
  >,
  authOrigin: string | undefined
): Promise<RelayRenewal> {
  const refresh = await options.refreshAccessToken()
  if (refresh.accessToken === null) {
    return { kind: 'refused', hostCloseReason: refresh.hostCloseReason }
  }
  if (!options.isCurrent()) {
    throw new StaleRelayBrokerError()
  }
  // Judged at the transport, so a malformed 2xx body or a local error never counts as unanswered.
  let unanswered = false
  const send = options.fetch ?? globalThis.fetch
  const observedFetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const response = await send(input, init)
      unanswered = response.status >= 500
      return response
    } catch (error) {
      unanswered = true
      throw error
    }
  }
  try {
    const authorization = await exchangeRelayAuthorization({
      endpoint: authOrigin
        ? relayTokenEndpointAt(authOrigin)
        : options.authConfig.relayTokenEndpoint,
      accessToken: refresh.accessToken,
      keypair: options.keypair,
      fetch: observedFetch
    })
    return { kind: 'renewed', authorization }
  } catch (error) {
    throw unanswered ? new RelayTokenUnansweredError(error) : error
  }
}
