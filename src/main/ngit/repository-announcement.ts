import { npubEncode } from 'nostr-tools/nip19'
import { NOSTR_KIND } from './nostr-event-kinds'
import { byNewest, tagValue, tagValues, type NostrEvent } from './nostr-event-tags'
import { normalizeRelayUrl, type NostrQuery } from './nostr-relay-session'
import { pubkeyFromNpub } from './nostr-repository-address'

/** Asked beside a URL's relay hint, so an announcement is found even from a bare `npub/name`. */
export const DEFAULT_DISCOVERY_RELAYS = [
  'wss://relay.ngit.dev',
  'wss://gitnostr.com',
  'wss://relay.damus.io',
  'wss://nos.lol'
]
const MAX_MAINTAINERS = 32
const MAX_RELAYS = 12

export type NostrRepository = {
  identifier: string
  ownerPubkey: string
  name: string
  /** Everyone whose status, label and update events count. */
  maintainers: string[]
  /** `30617:<pubkey>:<identifier>` for every maintainer; items may tag any of them. */
  coordinates: string[]
  relays: string[]
  cloneUrls: string[]
  webUrl: string
}

function announcementMaintainers(event: NostrEvent): string[] {
  return event.tags
    .filter((tag) => tag[0] === 'maintainers')
    .flatMap((tag) => tag.slice(1))
    .flatMap((value) => pubkeyFromNpub(value) ?? [])
}

export async function fetchNostrRepository(
  query: NostrQuery,
  ownerPubkey: string,
  identifier: string,
  relayHints: readonly string[]
): Promise<NostrRepository | null> {
  let relays = [...new Set([...relayHints, ...DEFAULT_DISCOVERY_RELAYS])]
  const announcements = new Map<string, NostrEvent>()
  const maintainers = new Set([ownerPubkey])
  let unasked = [ownerPubkey]
  // Maintainership is recursive: each maintainer's own announcement may name more.
  while (unasked.length > 0) {
    const events = await query(relays, [
      { kinds: [NOSTR_KIND.repositoryAnnouncement], authors: unasked, '#d': [identifier] }
    ])
    unasked = []
    for (const event of events.toSorted(byNewest)) {
      if (announcements.has(event.pubkey) || tagValue(event, 'd') !== identifier) {
        continue
      }
      announcements.set(event.pubkey, event)
      for (const pubkey of announcementMaintainers(event)) {
        if (!maintainers.has(pubkey) && maintainers.size < MAX_MAINTAINERS) {
          maintainers.add(pubkey)
          unasked.push(pubkey)
        }
      }
      relays = [
        ...new Set([
          ...relays,
          ...event.tags.filter((t) => t[0] === 'relays').flatMap((t) => t.slice(1))
        ])
      ]
    }
  }
  const primary =
    announcements.get(ownerPubkey) ?? [...announcements.values()].toSorted(byNewest)[0]
  if (!primary) {
    return null
  }
  const all = [primary, ...[...announcements.values()].filter((event) => event !== primary)]
  const listed = (name: string): string[] =>
    all.flatMap((event) => event.tags.filter((t) => t[0] === name).flatMap((t) => t.slice(1)))
  const repositoryRelays = [
    ...new Set([...listed('relays'), ...relayHints].flatMap((r) => normalizeRelayUrl(r) ?? []))
  ].slice(0, MAX_RELAYS)
  return {
    identifier,
    ownerPubkey: primary.pubkey,
    name: tagValue(primary, 'name') || identifier,
    maintainers: [...maintainers],
    coordinates: [...maintainers].map(
      (pubkey) => `${NOSTR_KIND.repositoryAnnouncement}:${pubkey}:${identifier}`
    ),
    relays: repositoryRelays.length > 0 ? repositoryRelays : DEFAULT_DISCOVERY_RELAYS,
    cloneUrls: [...new Set(listed('clone'))],
    webUrl: gitworkshopRepositoryUrl(
      primary.pubkey,
      identifier,
      repositoryRelays[0],
      tagValues(primary, 'web')
    )
  }
}

function gitworkshopRepositoryUrl(
  pubkey: string,
  identifier: string,
  relay: string | undefined,
  announced: readonly string[]
): string {
  const gitworkshop = announced.find((url) => url.startsWith('https://gitworkshop.dev/'))
  if (gitworkshop) {
    return gitworkshop.replace(/\/+$/, '')
  }
  const hint = relay ? `/${encodeURIComponent(relay.replace(/^wss?:\/\//, ''))}` : ''
  return `https://gitworkshop.dev/${npubEncode(pubkey)}${hint}/${encodeURIComponent(identifier)}`
}
