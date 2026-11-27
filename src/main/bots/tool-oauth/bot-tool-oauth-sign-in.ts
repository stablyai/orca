// A sign-in to a bot's app in the user's browser: registration, PKCE and the code exchange, owned by
// the caller that started it, spent once, and expiring.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  exchangeAuthorization,
  registerClient,
  startAuthorization
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  commitBotToolOAuth,
  readBotToolOAuth,
  type BotToolOAuthEntry,
  type BotToolOAuthRecord
} from '../bot-tool-credentials'
import { discoverBotToolAuth, type BotToolAuthServer } from './bot-tool-oauth-discovery'
import { isSecureOAuthEndpoint } from './secure-oauth-fetch'
import {
  ATTEMPT_TTL_MS,
  BotToolSignInError,
  TOKEN_DEADLINE_MS,
  discoveryOptions,
  extra,
  fetchFor,
  inTransaction,
  now,
  sameIssuer,
  type BotToolOAuthKey
} from './bot-tool-oauth'
import { revokeTokens } from './bot-tool-oauth-revoke'

/**
 * One sign-in waiting for the browser. The caller that started it owns it: the callback that
 * finishes it must present its `state`, and it expires. The PKCE verifier lives only in memory.
 */
export type BotToolSignInAttempt = {
  readonly key: BotToolOAuthKey
  /** Names the attempt to its caller; not the OAuth `state`, which only the browser carries. */
  readonly id: string
  readonly state: string
  readonly authorizationUrl: string
  readonly redirectUri: string
  readonly issuer: string
  readonly expiresAt: number
  /** Ends the attempt: its exchange, if running, is aborted and never commits. */
  cancel(): void
  /** Spends the code once; resolves after the tokens are stored. */
  complete(answer: { code: string; iss?: string | null }): Promise<void>
  /**
   * Whether a callback query is this attempt's well-formed return: every parameter once (RFC 6749
   * §4.1.2), exactly one of `code` and `error`, and its own `state`. Anything else is ignored by the
   * caller and spends nothing, so a stray, forged or mangled return can't end a sign-in.
   */
  owns(query: URLSearchParams): boolean
  /** Finishes from the callback query of a hit `owns` accepted; `error=` is read only after that. */
  completeFromCallback(query: URLSearchParams): Promise<void>
}

/** What Orca registers as: a public native client (RFC 8252) for one exact redirect. */
function clientMetadata(redirectUri: string, metadata: AuthorizationServerMetadata) {
  const methods = metadata.token_endpoint_auth_methods_supported
  const method = methods?.includes('none')
    ? 'none'
    : methods?.includes('client_secret_post') && !methods.includes('client_secret_basic')
      ? 'client_secret_post'
      : undefined
  return {
    client_name: 'Orca',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...(method ? { token_endpoint_auth_method: method } : {})
  } satisfies OAuthClientMetadata
}

/** The scope to ask for, with `offline_access` added only where the server offers it. */
function requestedScope(server: BotToolAuthServer): string | undefined {
  const scope = server.scope?.trim()
  if (!scope || !server.metadata.scopes_supported?.includes('offline_access')) {
    return scope || undefined
  }
  return scope.split(/\s+/).includes('offline_access') ? scope : `${scope} offline_access`
}

/** Google issues a refresh token only for an offline request with consent. */
function withProviderOfflineAccess(url: URL): URL {
  if (url.origin !== 'https://accounts.google.com' || url.searchParams.has('access_type')) {
    return url
  }
  const next = new URL(url)
  next.searchParams.set('access_type', 'offline')
  if (!next.searchParams.has('prompt')) {
    next.searchParams.set('prompt', 'consent')
  }
  return next
}

/**
 * Starts a sign-in for the bot's tool. `redirectUri` is the caller's listener, already bound: it
 * stays fixed for the attempt, and the registration is made for exactly it.
 */
export async function beginBotToolSignIn(
  key: BotToolOAuthKey,
  { redirectUri, signal }: { redirectUri: string; signal?: AbortSignal }
): Promise<BotToolSignInAttempt> {
  const entry = readBotToolOAuth(key.folder, key.credentialId)
  if (!entry) {
    throw new BotToolSignInError('no-tool')
  }
  const need = await discoverBotToolAuth(entry.url, discoveryOptions(signal))
  if (need.kind === 'unavailable') {
    throw new BotToolSignInError('unavailable')
  }
  if (need.kind !== 'oauth') {
    throw new BotToolSignInError('unsupported')
  }
  const fetchFn = fetchFor(entry.url, signal)
  const stored = entry.record
  // A registration is reused only for the issuer and exact redirect it was made for.
  let client: OAuthClientInformationMixed | undefined =
    stored.client &&
    stored.issuer &&
    sameIssuer(stored.issuer, need.issuer) &&
    stored.redirectUri === redirectUri
      ? stored.client
      : undefined
  if (!client) {
    try {
      client = await registerClient(need.issuer, {
        metadata: need.metadata,
        clientMetadata: clientMetadata(redirectUri, need.metadata),
        fetchFn
      })
    } catch {
      throw new BotToolSignInError('unsupported')
    }
  }
  const state = randomBytes(32).toString('base64url')
  const scope = requestedScope(need)
  let started: Awaited<ReturnType<typeof startAuthorization>>
  try {
    started = await startAuthorization(need.issuer, {
      metadata: need.metadata,
      clientInformation: client,
      redirectUrl: redirectUri,
      state,
      resource: need.resource,
      ...(scope ? { scope } : {})
    })
  } catch {
    // No S256 or no `code` response type: OAuth 2.1 requires both.
    throw new BotToolSignInError('unsupported')
  }
  const authorizationUrl = withProviderOfflineAccess(started.authorizationUrl)
  // The address comes from the app's own metadata; only a web page (or this machine) may open.
  if (!isSecureOAuthEndpoint(authorizationUrl)) {
    throw new BotToolSignInError('unsupported')
  }
  return makeAttempt(key, entry, need, {
    client,
    state,
    redirectUri,
    codeVerifier: started.codeVerifier,
    authorizationUrl: authorizationUrl.href,
    ...(scope ? { scope } : {})
  })
}

function makeAttempt(
  key: BotToolOAuthKey,
  entry: BotToolOAuthEntry,
  server: BotToolAuthServer,
  started: {
    client: OAuthClientInformationMixed
    state: string
    redirectUri: string
    codeVerifier: string
    authorizationUrl: string
    scope?: string
  }
): BotToolSignInAttempt {
  const controller = new AbortController()
  const expiresAt = now() + ATTEMPT_TTL_MS
  let spent = false
  const attempt: BotToolSignInAttempt = {
    key,
    id: randomBytes(12).toString('base64url'),
    state: started.state,
    authorizationUrl: started.authorizationUrl,
    redirectUri: started.redirectUri,
    issuer: server.issuer,
    expiresAt,
    cancel: () => controller.abort(),
    complete: async ({ code, iss }) => {
      if (spent) {
        throw new BotToolSignInError('superseded')
      }
      spent = true
      if (controller.signal.aborted) {
        throw new BotToolSignInError('cancelled')
      }
      if (now() > expiresAt) {
        throw new BotToolSignInError('expired')
      }
      // RFC 9207: a server that sends `iss` names itself; a wrong one is a mix-up attack.
      const issRequired =
        extra(server.metadata).authorization_response_iss_parameter_supported === true
      if ((iss ?? null) === null ? issRequired : !sameIssuer(iss!, server.issuer)) {
        throw new BotToolSignInError('issuer-mismatch')
      }
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(TOKEN_DEADLINE_MS)])
      let tokens: OAuthTokens
      try {
        tokens = await exchangeAuthorization(server.issuer, {
          metadata: server.metadata,
          clientInformation: started.client,
          authorizationCode: code,
          codeVerifier: started.codeVerifier,
          redirectUri: started.redirectUri,
          resource: server.resource,
          fetchFn: fetchFor(entry.url, deadline)
        })
      } catch {
        throw new BotToolSignInError(controller.signal.aborted ? 'cancelled' : 'refused')
      }
      const record: BotToolOAuthRecord = {
        resource: server.resource,
        issuer: server.issuer,
        ...(server.resourceMetadataUrl ? { resourceMetadataUrl: server.resourceMetadataUrl } : {}),
        ...(started.scope ? { scope: started.scope } : {}),
        client: started.client,
        redirectUri: started.redirectUri,
        tokens,
        obtainedAt: now()
      }
      const seen: { replaced?: BotToolOAuthRecord; removed?: boolean } = {}
      const committed = await inTransaction(key, () =>
        commitBotToolOAuth(key.folder, key.credentialId, (current) => {
          seen.removed = !current || current.url !== entry.url
          // Removed, signed out, re-pointed or signed in again since this attempt began: not ours.
          if (
            !current ||
            controller.signal.aborted ||
            seen.removed ||
            current.grant !== entry.grant
          ) {
            return undefined
          }
          seen.replaced = current.record
          return { url: current.url, grant: current.grant + 1, record }
        })
      )
      if (!committed) {
        // Revoked only when nothing else holds the tool: some servers end every grant a client
        // has for a user on one revocation, which would end a newer sign-in too.
        if (seen.removed) {
          void revokeTokens(entry.url, record)
        }
        throw new BotToolSignInError(controller.signal.aborted ? 'cancelled' : 'superseded')
      }
      // The sign-in it replaced ends too, unless it was the same client (see above).
      const old = seen.replaced
      if (old?.tokens && old.client?.client_id !== started.client.client_id) {
        void revokeTokens(entry.url, old)
      }
    },
    owns: (query) => {
      const names = [...query.keys()]
      if (new Set(names).size !== names.length || query.has('code') === query.has('error')) {
        return false
      }
      const given = Buffer.from(query.get('state') ?? '')
      const expected = Buffer.from(started.state)
      return given.length === expected.length && timingSafeEqual(given, expected)
    },
    completeFromCallback: async (query) => {
      if (!attempt.owns(query)) {
        throw new BotToolSignInError('superseded')
      }
      if (query.has('error')) {
        spent = true
        controller.abort()
        throw new BotToolSignInError(query.get('error') === 'access_denied' ? 'denied' : 'refused')
      }
      await attempt.complete({ code: query.get('code') ?? '', iss: query.get('iss') })
    }
  }
  return attempt
}

/**
 * A new tool's sign-in, signed out; its tokens come from `beginBotToolSignIn`. Queues behind the
 * folder's transactions, so never call it inside one: add a tool with its sign-in through
 * `changeBotToolServers(..., new Map([[id, { url, signIn: true }]]))` instead.
 */
export function createBotToolSignIn(key: BotToolOAuthKey, url: string): Promise<void> {
  return inTransaction(key, () => {
    commitBotToolOAuth(key.folder, key.credentialId, (current) =>
      current ? undefined : { url, grant: 0, record: { resource: url } }
    )
  })
}
