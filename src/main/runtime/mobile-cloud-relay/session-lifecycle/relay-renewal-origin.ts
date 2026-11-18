import type { OrcaCloudAuthConfig } from '../../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../../../orca-profiles/cloud-auth/profile-cloud-client'
import {
  exchangeRelayAuthorization,
  RelayHttpError,
  type RelayAuthorization
} from '../director/relay-http-client'
import type { RelayHostCloseReason } from '../../../../shared/remote-runtime/relay/relay-host-close-reason'
import { StaleRelayBrokerError } from './relay-session-broker-contract'
import type { RelaySessionBrokerOptions } from './relay-session-broker-contract'

// The auth config with the two endpoints relay token renewal uses moved to a director-provided
// authOrigin (AssignmentResponse.authOrigin, the front door the assignment routes through). Every
// other endpoint stays on the configured auth base.
export function relayAuthConfigAt(
  config: OrcaCloudAuthConfig,
  authOrigin: string
): OrcaCloudAuthConfig {
  return {
    ...config,
    refreshEndpoint: new URL('/v1/desktop/auth/refresh', `${authOrigin}/`).toString(),
    relayTokenEndpoint: new URL('/v1/desktop/auth/relay-token', `${authOrigin}/`).toString()
  }
}

// A 4xx is the auth server's answer about the credential, which another origin would repeat; only
// unanswered attempts (network error, timeout) and 5xx are worth another origin.
function isAuthAnswer(error: unknown): boolean {
  const statusCode =
    error instanceof OrcaCloudRequestError || error instanceof RelayHttpError
      ? error.statusCode
      : null
  return statusCode !== null && statusCode >= 400 && statusCode < 500
}

// Which origin the next renewal attempt uses. Without an authOrigin every attempt uses the
// configured endpoints, exactly as before authOrigin existed. With one, each failed attempt that
// got no auth answer flips to the other origin, so retries alternate between the two.
export class RelayRenewalOrigin {
  private viaAuthOrigin = false

  // undefined: the configured auth endpoints.
  next(authOrigin: string | undefined): string | undefined {
    return this.viaAuthOrigin && authOrigin ? authOrigin : undefined
  }

  succeeded(): void {
    this.viaAuthOrigin = false
  }

  failed(error: unknown, authOrigin: string | undefined): void {
    this.viaAuthOrigin = authOrigin !== undefined && !isAuthAnswer(error) && !this.viaAuthOrigin
  }
}

// One renewal attempt through `authOrigin` (or the configured endpoints): a fresh access token,
// then a relay token. 'refused': the account can no longer hold the relay.
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
  const refresh = await options.refreshAccessToken(authOrigin)
  if (refresh.accessToken === null) {
    return { kind: 'refused', hostCloseReason: refresh.hostCloseReason }
  }
  if (!options.isCurrent()) {
    throw new StaleRelayBrokerError()
  }
  const config = authOrigin ? relayAuthConfigAt(options.authConfig, authOrigin) : options.authConfig
  const authorization = await exchangeRelayAuthorization({
    endpoint: config.relayTokenEndpoint,
    accessToken: refresh.accessToken,
    keypair: options.keypair,
    fetch: options.fetch
  })
  return { kind: 'renewed', authorization }
}
