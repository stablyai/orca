import { decode, npubEncode } from 'nostr-tools/nip19'
import { parse as parseYaml } from 'yaml'
import { normalizeRelayUrl } from './nostr-relay-session'

/** What a remote URL or `maintainers.yaml` says about a repository, before any relay is asked. */
export type NostrRepositoryAddress = {
  /** Hex public key, or a NIP-05 name still to be resolved. */
  owner: { pubkey: string } | { nip05: string }
  identifier: string
  relayHints: string[]
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/

export function pubkeyFromNpub(value: string): string | null {
  const trimmed = value.trim()
  if (HEX_PUBKEY.test(trimmed)) {
    return trimmed
  }
  try {
    const decoded = decode(trimmed)
    return decoded.type === 'npub' ? decoded.data : null
  } catch {
    return null
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** `nostr://<npub|nip05|domain|naddr>[/<relay-hint>]/<identifier>` */
export function parseNostrCloneUrl(remoteUrl: string): NostrRepositoryAddress | null {
  const match = remoteUrl.trim().match(/^nostr:\/\/(.+?)\/*$/i)
  if (!match) {
    return null
  }
  const parts = match[1].split('/').filter(Boolean).map(safeDecode)
  const authority = parts[0]
  if (!authority) {
    return null
  }
  if (authority.startsWith('naddr1')) {
    try {
      const decoded = decode(authority)
      return decoded.type === 'naddr'
        ? {
            owner: { pubkey: decoded.data.pubkey },
            identifier: decoded.data.identifier,
            relayHints: decoded.data.relays ?? []
          }
        : null
    } catch {
      return null
    }
  }
  if (parts.length < 2) {
    return null
  }
  const identifier = parts.at(-1)!.replace(/\.git$/i, '')
  // A hint may itself be a full `wss://…` URL, which splits into several segments.
  const hint = parts
    .slice(1, -1)
    .join('/')
    .replace(/^(wss?):\/?/i, '$1://')
  const relay = hint ? normalizeRelayUrl(hint) : null
  const pubkey = pubkeyFromNpub(authority)
  if (!pubkey && !authority.includes('.')) {
    return null
  }
  return {
    owner: pubkey ? { pubkey } : { nip05: authority },
    identifier,
    relayHints: relay ? [relay] : []
  }
}

/** A GRASP server's git URL: `https://<relay>/<npub>/<identifier>.git`. */
export function parseGraspCloneUrl(remoteUrl: string): NostrRepositoryAddress | null {
  const match = remoteUrl
    .trim()
    .match(/^(https?):\/\/([^/@]+)\/(npub1[02-9ac-hj-np-z]{58})\/([^/]+?)(?:\.git)?\/*$/i)
  if (!match) {
    return null
  }
  const [, protocol, host, npub, identifier] = match
  const pubkey = pubkeyFromNpub(npub)
  const relay = normalizeRelayUrl(`${protocol === 'http' ? 'ws' : 'wss'}://${host}`)
  return pubkey && relay
    ? { owner: { pubkey }, identifier: safeDecode(identifier), relayHints: [relay] }
    : null
}

export function parseNostrRemoteUrl(remoteUrl: string): NostrRepositoryAddress | null {
  return parseNostrCloneUrl(remoteUrl) ?? parseGraspCloneUrl(remoteUrl)
}

/** ngit's older in-repo declaration; `identifier` is optional there. */
export function parseMaintainersYaml(
  text: string,
  fallbackIdentifier: string
): NostrRepositoryAddress | null {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const { maintainers, relays, identifier } = parsed as Record<string, unknown>
  const pubkey = Array.isArray(maintainers)
    ? maintainers.map((value) => pubkeyFromNpub(String(value))).find((value) => value !== null)
    : undefined
  if (!pubkey) {
    return null
  }
  return {
    owner: { pubkey },
    identifier: typeof identifier === 'string' && identifier ? identifier : fallbackIdentifier,
    relayHints: Array.isArray(relays)
      ? relays.flatMap((relay) => normalizeRelayUrl(String(relay)) ?? [])
      : []
  }
}

/** The URL `ngit --repo` accepts for a resolved repository. */
export function formatNostrCloneUrl(
  pubkey: string,
  identifier: string,
  relay: string | undefined
): string {
  const hint = relay?.startsWith('wss://') ? `/${encodeURIComponent(relay.slice(6))}` : ''
  return `nostr://${npubEncode(pubkey)}${hint}/${encodeURIComponent(identifier)}`
}
