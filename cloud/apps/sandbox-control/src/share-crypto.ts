// Share-link keys. One server secret (SHARE_LINK_SECRET), domain-separated with HMAC labels into:
//   - the ticket tag: a link's URL token is `<id hex><tag hex>`, so a guessed or edited token is
//     refused before any database read;
//   - the per-session proxy key the VM's share proxy (image/vm/orca-share-proxy) checks;
//   - the viewer cookie and the one-time sign-in code for team-only links.
// Everything is lowercase hex so a token also fits a DNS label (the per-link subdomain mode).

const encoder = new TextEncoder()
const keyCache = new Map<string, Promise<CryptoKey>>()

/** Ticket = 16 random bytes (id) + 10 bytes of HMAC tag: 52 hex chars, under the 63-char DNS label cap. */
const ID_BYTES = 16
const TAG_BYTES = 10
export const TICKET_PATTERN = /^[0-9a-f]{52}$/

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function hmacKey(raw: Uint8Array | string): Promise<CryptoKey> {
  const cacheKey = typeof raw === 'string' ? `s:${raw}` : `b:${hex(raw)}`
  let key = keyCache.get(cacheKey)
  if (!key) {
    key = crypto.subtle.importKey('raw', typeof raw === 'string' ? encoder.encode(raw) : raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign'
    ])
    keyCache.set(cacheKey, key)
    key.catch(() => keyCache.delete(cacheKey))
  }
  return key
}

async function hmac(key: Uint8Array | string, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(key), encoder.encode(message)))
}

/** Constant-time compare of two equal-purpose strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export function newShareId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(ID_BYTES)))
}

export async function ticketFor(secret: string, id: string): Promise<string> {
  return id + hex((await hmac(secret, `ticket:${id}`)).slice(0, TAG_BYTES))
}

/** Current secret first; a retired one (SHARE_LINK_SECRET_PREVIOUS) still verifies during rotation. */
export type ShareSecrets = string | readonly string[]

function secretList(secrets: ShareSecrets): readonly string[] {
  return typeof secrets === 'string' ? [secrets] : secrets
}

/** The share id behind a ticket, or null when no accepted secret minted it. */
export async function verifyTicket(secrets: ShareSecrets, ticket: string): Promise<string | null> {
  if (!TICKET_PATTERN.test(ticket)) {
    return null
  }
  const id = ticket.slice(0, ID_BYTES * 2)
  for (const secret of secretList(secrets)) {
    if (safeEqual(await ticketFor(secret, id), ticket)) {
      return id
    }
  }
  return null
}

/** The key one VM session's share proxy checks: derived, never stored; rotates with every session. */
export async function shareProxyKey(secret: string, sandboxId: string, sessionId: string): Promise<string> {
  return base64url(await hmac(secret, `proxy:${sandboxId}:${sessionId}`))
}

/**
 * A proxied connection never outlives this, so a revoke also ends open WebSockets and streams within
 * it. Long enough that dev-server HMR sockets rarely reconnect; expiry still cuts at the exact time.
 */
export const MAX_PROXY_CONNECTION_MS = 30 * 60_000

/**
 * `x-orca-share` for one proxied request:
 *   v2.<port>.<expiresAt>.<until>.<linkId>.<sig>
 * The request must start within 60s (`expiresAt`); the proxy closes the connection at `until`
 * (the link's expiry, at most 30 minutes out). Both are unix seconds; `linkId` ties it to one link.
 */
export async function signProxyHeader(
  proxyKey: string,
  grant: { port: number; linkId: string; linkExpiresAt: number },
  nowMs: number
): Promise<string> {
  const expiresAt = Math.floor(nowMs / 1000) + 60
  const until = Math.floor(Math.min(grant.linkExpiresAt, nowMs + MAX_PROXY_CONNECTION_MS) / 1000)
  const raw = Uint8Array.from(atob(proxyKey.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
  const signed = `v2.${grant.port}.${expiresAt}.${until}.${grant.linkId}`
  return `${signed}.${base64url(await hmac(raw, signed))}`
}

/** A signed, expiring JSON blob (viewer cookie, one-time sign-in code); `purpose` keeps them apart. */
export async function sealClaims(secret: string, purpose: string, claims: Record<string, unknown>): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(claims)))
  return `${body}.${base64url(await hmac(secret, `${purpose}:${body}`))}`
}

export async function openClaims<T extends { exp: number }>(
  secrets: ShareSecrets,
  purpose: string,
  sealed: string,
  nowMs: number
): Promise<T | null> {
  const [body, tag, extra] = sealed.split('.')
  if (!body || !tag || extra !== undefined || body.length > 2048) {
    return null
  }
  let valid = false
  for (const secret of secretList(secrets)) {
    valid ||= safeEqual(base64url(await hmac(secret, `${purpose}:${body}`)), tag)
  }
  if (!valid) {
    return null
  }
  try {
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)))) as T
    return typeof claims.exp === 'number' && claims.exp > nowMs ? claims : null
  } catch {
    return null
  }
}
