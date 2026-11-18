// Orca as the OAuth client of a bot's app: one sign-in per bot and tool, kept on the host, refreshed
// and revoked here, so the bot's agent (Claude or Codex) never holds a token. OAuth 2.1 with PKCE
// (RFC 7636), dynamic registration (RFC 7591), resource indicators (RFC 8707), issuer checks
// (RFC 9207) and revocation (RFC 7009), following the MCP authorization spec. This file holds what
// the sign-in, token and revocation modules share.
import type { BotToolSignInFailure } from '../../../shared/bot-tool-sign-in'
import { z } from 'zod'
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { botToolCredentialsTransaction, type BotToolOAuthRecord } from '../bot-tool-credentials'
import type { BotToolDiscoveryOptions } from './bot-tool-oauth-discovery'
import { secureOAuthFetch, type OAuthFetch } from './secure-oauth-fetch'
import type { AddressLookup } from './oauth-endpoint-address'

/** One bot's credential: the host folder it belongs to and its id there. */
export type BotToolOAuthKey = { folder: string; credentialId: string }

/** A usable access token and the sign-in it belongs to. */
export type BotToolGrant = { token: string; grant: number }

/** A failure with a fixed code; its message never carries provider text, a URL or a secret. */
export class BotToolSignInError extends Error {
  constructor(readonly code: BotToolSignInFailure) {
    super(`Sign-in failed: ${code}`)
  }
}

/** Test seams; production uses Orca's HTTP client, the system resolver and the clock. */
export type BotToolOAuthDeps = { fetch?: OAuthFetch; lookup?: AddressLookup; now?: () => number }
let deps: BotToolOAuthDeps = {}
export function setBotToolOAuthDeps(next: BotToolOAuthDeps): void {
  deps = next
}
export const now = (): number => (deps.now ?? Date.now)()

export const ATTEMPT_TTL_MS = 5 * 60_000
export const TOKEN_DEADLINE_MS = 15_000
export const REVOKE_DEADLINE_MS = 5_000
/** Refreshed this long before it expires, so a call that starts now doesn't carry a dying token. */
export const REFRESH_MARGIN_MS = 60_000

export const keyOf = (key: BotToolOAuthKey): string => `${key.folder}\0${key.credentialId}`

export function fetchFor(resource: string, signal?: AbortSignal): OAuthFetch {
  return secureOAuthFetch({
    resource,
    ...(signal ? { signal } : {}),
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {})
  })
}

export const discoveryOptions = (signal?: AbortSignal): BotToolDiscoveryOptions => ({
  ...(signal ? { signal } : {}),
  ...(deps.lookup ? { lookup: deps.lookup } : {}),
  ...(deps.fetch ? { fetch: deps.fetch } : {})
})

const MetadataExtras = z.looseObject({
  revocation_endpoint: z.string().optional().catch(undefined),
  revocation_endpoint_auth_methods_supported: z.array(z.string()).optional().catch(undefined),
  authorization_response_iss_parameter_supported: z.boolean().optional().catch(undefined)
})

/** Fields only the OAuth (not OIDC) metadata shape declares, read from either. */
export const extra = (metadata: AuthorizationServerMetadata) => MetadataExtras.parse(metadata)

/** Issuer identifiers compare as exact strings (RFC 8414 §3.3, RFC 9207 §2.4): no normalizing. */
export const sameIssuer = (left: string, right: string): boolean => left === right

export function inTransaction<T>(key: BotToolOAuthKey, work: () => T): Promise<T> {
  return botToolCredentialsTransaction(key.folder, work)
}

export function expiring(record: BotToolOAuthRecord, margin = REFRESH_MARGIN_MS): boolean {
  const seconds = record.tokens?.expires_in
  // A token that states no lifetime is taken at its word, not refreshed on a guess.
  if (seconds === undefined || record.obtainedAt === undefined) {
    return false
  }
  return record.obtainedAt + seconds * 1000 - margin <= now()
}
