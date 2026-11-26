import { z } from 'zod'

const Nip05Document = z.object({ names: z.record(z.string(), z.unknown()) })

const LOOKUP_TIMEOUT_MS = 8_000
const MAX_RESPONSE_CHARS = 512 * 1024
const NAME_PATTERN = /^[a-z0-9._-]+$/i
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export type Nip05Fetch = (url: string, init: RequestInit) => Promise<Response>

/** Resolves `user@domain`, or a bare `domain` as its `_` name, to a hex public key. */
export async function lookupNip05Pubkey(
  address: string,
  fetchImpl: Nip05Fetch = fetch
): Promise<string | null> {
  const at = address.lastIndexOf('@')
  const name = at === -1 ? '_' : address.slice(0, at)
  const domain = address.slice(at + 1)
  if (!NAME_PATTERN.test(name) || !DOMAIN_PATTERN.test(domain)) {
    return null
  }
  // NIP-05 forbids following redirects: they would let another host vouch for this name.
  const response = await fetchImpl(
    `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
    { redirect: 'error', signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) }
  )
  if (!response.ok) {
    return null
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_CHARS) {
    return null
  }
  const parsed = Nip05Document.safeParse(JSON.parse(text))
  const pubkey = parsed.success ? parsed.data.names[name] : undefined
  return typeof pubkey === 'string' && /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : null
}
