// What an app's MCP address needs before a bot can use it: nothing, Orca's own sign-in, a sign-in
// Orca can't make yet, or no answer worth deciding on. MCP authorization (2025-06-18) over RFC 9728
// protected-resource metadata and RFC 8414 / OIDC authorization-server metadata.
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl
} from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import type {
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { InitializeResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getMainHttpClient } from '../../network/http-client'
import { isSecureOAuthEndpoint, secureOAuthFetch, type OAuthFetch } from './secure-oauth-fetch'
import type { AddressLookup } from './oauth-endpoint-address'

/** Where an app signs Orca in, as discovery found it. */
export type BotToolAuthServer = {
  issuer: string
  metadata: AuthorizationServerMetadata
  /** The resource indicator to send, verbatim (RFC 8707). */
  resource: string
  resourceMetadataUrl?: string
  scope?: string
}

export type BotToolAuthNeed =
  /** The app answered an MCP request without a sign-in and names no authorization server. */
  | { kind: 'none' }
  | ({ kind: 'oauth' } & BotToolAuthServer)
  /** It needs a sign-in Orca can't make yet: no dynamic registration. */
  | { kind: 'unsupported' }
  /** No answer to decide on: unreachable, a server error, or not an MCP server. Try again later. */
  | { kind: 'unavailable' }

export type BotToolDiscoveryOptions = {
  signal?: AbortSignal
  lookup?: AddressLookup
  fetch?: OAuthFetch
}

const PROBE_DEADLINE_MS = 15_000
const PROTOCOL_VERSION = '2025-06-18'
/** Busy or failing: says nothing about whether the app wants a sign-in. */
const transient = (status: number): boolean => status >= 500 || status === 408 || status === 429

class Unavailable extends Error {}

/** An unauthenticated MCP `initialize`: its status, and the challenge a 401 carries. */
async function probe(url: string, options: BotToolDiscoveryOptions) {
  const send =
    options.fetch ??
    ((target: string | URL, init?: RequestInit) => getMainHttpClient().fetch(String(target), init))
  const signal = AbortSignal.any(
    [AbortSignal.timeout(PROBE_DEADLINE_MS), options.signal].filter((s): s is AbortSignal => !!s)
  )
  let response: Response
  try {
    response = await send(url, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'Orca', version: '1' }
        }
      })
    })
  } catch {
    throw new Unavailable()
  }
  const challenge = response.status === 401 ? extractWWWAuthenticateParams(response) : {}
  const ok = response.status >= 200 && response.status < 300
  const mcp = ok ? await answersInitialize(response).catch(() => false) : false
  await response.body?.cancel().catch(() => undefined)
  return { status: response.status, mcp, challenge }
}

// The initialize answer is small; a body past this, or no answer, isn't one.
const INITIALIZE_BYTES = 64 * 1024
const InitializeResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.literal(1),
  result: z.unknown()
})

/** The JSON-RPC answer to our `initialize`, carrying a complete MCP initialize result. */
const isInitializeResult = (text: string): boolean => {
  try {
    const response = InitializeResponse.safeParse(JSON.parse(text))
    return response.success && InitializeResultSchema.safeParse(response.data.result).success
  } catch {
    return false
  }
}

/**
 * Whether the body is an MCP `initialize` result, as JSON or as the first matching SSE event;
 * reading stops there, since an event stream may stay open.
 */
async function answersInitialize(response: Response): Promise<boolean> {
  const type = response.headers.get('content-type') ?? ''
  const sse = /^text\/event-stream/i.test(type)
  if (!sse && !/^application\/json/i.test(type)) {
    return false
  }
  const reader = response.body?.getReader()
  if (!reader) {
    return false
  }
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) {
        text += decoder.decode(value, { stream: true })
      }
      if (text.length > INITIALIZE_BYTES) {
        return false
      }
      if (sse) {
        // Each event's data lines joined (the SSE spec); a later event may be the answer.
        const events = text.replace(/\r\n?/g, '\n').split('\n\n')
        const complete = done ? events : events.slice(0, -1)
        for (const event of complete) {
          const data = event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n')
          if (data && isInitializeResult(data)) {
            return true
          }
        }
      }
      if (done) {
        return !sse && isInitializeResult(text)
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * The authorization server's metadata, only when the document names the issuer it was fetched for
 * (RFC 8414 §3.3): one naming another server must not lend it its endpoints. Undefined when the
 * server publishes none or it names another issuer.
 */
export async function issuerMetadata(
  issuer: string,
  fetchFn: OAuthFetch
): Promise<AuthorizationServerMetadata | undefined> {
  const metadata = await discoverAuthorizationServerMetadata(issuer, {
    fetchFn,
    protocolVersion: PROTOCOL_VERSION
  })
  return metadata?.issuer === issuer ? metadata : undefined
}

/** Sorts an app's address into what it needs. Never registers, and never sends a credential. */
export async function discoverBotToolAuth(
  url: string,
  options: BotToolDiscoveryOptions = {}
): Promise<BotToolAuthNeed> {
  if (!isSecureOAuthEndpoint(new URL(url))) {
    return { kind: 'unsupported' }
  }
  try {
    const answer = await probe(url, options)
    if (transient(answer.status)) {
      return { kind: 'unavailable' }
    }
    const open = answer.status >= 200 && answer.status < 300 && answer.mcp
    if (!open && answer.status !== 401) {
      // A 404, a refusal or a web page is not an MCP server answering without a sign-in.
      return { kind: 'unavailable' }
    }
    // Some apps list tools to anyone and ask for a sign-in only when one runs: metadata decides.
    const server = await findAuthServer(url, answer.challenge, options, answer.status === 401)
    if (server === 'none') {
      return open ? { kind: 'none' } : { kind: 'unsupported' }
    }
    if (server === 'unsupported' || !server.metadata.registration_endpoint) {
      return { kind: 'unsupported' }
    }
    return { kind: 'oauth', ...server }
  } catch {
    // Unreachable, timed out, or a document that isn't metadata: nothing to decide on yet.
    return { kind: 'unavailable' }
  }
}

/**
 * The authorization server the app names, 'none' when it names none, or 'unsupported' when what it
 * names can't be used. `required`: the app refused an unauthenticated request, so a missing metadata
 * document falls back to its own origin (MCP 2025-03-26) instead of meaning "no sign-in".
 */
export async function findAuthServer(
  url: string,
  challenge: { resourceMetadataUrl?: URL; scope?: string },
  options: BotToolDiscoveryOptions,
  required: boolean
): Promise<BotToolAuthServer | 'none' | 'unsupported'> {
  const fetchFn = secureOAuthFetch({
    resource: url,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  })
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined
  let status: number | null = null
  const watched: OAuthFetch = async (target, init) => {
    const response = await fetchFn(target, init)
    status = response.status
    return response
  }
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      url,
      {
        protocolVersion: PROTOCOL_VERSION,
        ...(challenge.resourceMetadataUrl
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {})
      },
      watched
    )
  } catch {
    // Only a clear answer (a 404 or another refusal below 500) means "no metadata".
    if (status === null || transient(status)) {
      throw new Unavailable()
    }
    resourceMetadata = undefined
  }
  const named = resourceMetadata?.authorization_servers?.[0]
  if (!named && !required) {
    return 'none'
  }
  const requested = resourceUrlFromServerUrl(url)
  if (
    resourceMetadata &&
    !checkResourceAllowed({
      requestedResource: requested,
      configuredResource: resourceMetadata.resource
    })
  ) {
    // Metadata for another resource: a token for it must never be spent here (RFC 9728 §3.3).
    return 'unsupported'
  }
  const issuer = named ?? new URL(url).origin
  if (!isSecureOAuthEndpoint(new URL(issuer))) {
    return 'unsupported'
  }
  let metadata: AuthorizationServerMetadata | undefined
  try {
    metadata = await issuerMetadata(issuer, fetchFn)
  } catch {
    throw new Unavailable()
  }
  if (!metadata) {
    return 'unsupported'
  }
  const scope = challenge.scope ?? resourceMetadata?.scopes_supported?.join(' ')
  return {
    issuer,
    metadata,
    resource: resourceMetadata?.resource ?? requested.href,
    ...(challenge.resourceMetadataUrl
      ? { resourceMetadataUrl: challenge.resourceMetadataUrl.href }
      : {}),
    ...(scope ? { scope } : {})
  }
}
