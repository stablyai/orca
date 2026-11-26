import { z } from 'zod'
import { lookupNip05Pubkey } from './nip05-lookup'
import { NOSTR_KIND, STATUS_KINDS } from './nostr-event-kinds'
import { byNewest, isPatchRevision, type NostrEvent } from './nostr-event-tags'
import {
  openNostrRelaySession,
  type NostrQuery,
  type NostrRelaySession
} from './nostr-relay-session'
import type { NostrRepositoryAddress } from './nostr-repository-address'
import { fetchNostrRepository, type NostrRepository } from './repository-announcement'
import {
  isWorkItemRoot,
  projectNostrWorkItems,
  type NostrProfile,
  type ProjectedWorkItem
} from './work-item-projection'

const SNAPSHOT_TTL_MS = 60_000
const MAX_CACHED_SNAPSHOTS = 64
const ID_CHUNK = 100
const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol']

export type NostrRepositorySnapshot = {
  repository: NostrRepository
  items: ProjectedWorkItem[]
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

const ProfileContent = z.object({
  display_name: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  picture: z.string().startsWith('https://').optional().catch(undefined)
})

function parseProfile(content: string): NostrProfile {
  try {
    const profile = ProfileContent.parse(JSON.parse(content))
    return {
      name: profile.display_name || profile.name || null,
      picture: profile.picture ?? null
    }
  } catch {
    return { name: null, picture: null }
  }
}

async function fetchProfiles(
  query: NostrQuery,
  relays: readonly string[],
  authors: readonly string[]
): Promise<Map<string, NostrProfile>> {
  const profiles = new Map<string, NostrProfile>()
  // Names are decoration: a repository still reads when no profile relay answers.
  const events = await query(
    [...relays, ...PROFILE_RELAYS],
    chunk(authors, ID_CHUNK).map((part) => ({ kinds: [NOSTR_KIND.profile], authors: part }))
  ).catch((): NostrEvent[] => [])
  for (const event of events.toSorted(byNewest)) {
    if (profiles.has(event.pubkey)) {
      continue
    }
    profiles.set(event.pubkey, parseProfile(event.content))
  }
  return profiles
}

/** Reads everything a repository's issues and pull requests are made of. */
export async function readNostrRepositorySnapshot(
  query: NostrQuery,
  ownerPubkey: string,
  identifier: string,
  relayHints: readonly string[]
): Promise<NostrRepositorySnapshot | null> {
  const repository = await fetchNostrRepository(query, ownerPubkey, identifier, relayHints)
  if (!repository) {
    return null
  }
  const addressed = await query(repository.relays, [
    {
      kinds: [NOSTR_KIND.issue, NOSTR_KIND.pullRequest],
      '#a': repository.coordinates
    },
    {
      kinds: [NOSTR_KIND.patch],
      '#a': repository.coordinates,
      '#t': ['root', 'root-revision', 'revision-root']
    }
  ])
  const rootIds = addressed.filter(isWorkItemRoot).map((event) => event.id)
  const related = await query(
    repository.relays,
    chunk(rootIds, ID_CHUNK).flatMap((ids) => [
      {
        kinds: [
          ...STATUS_KINDS,
          NOSTR_KIND.label,
          NOSTR_KIND.deletion,
          NOSTR_KIND.legacyReply,
          NOSTR_KIND.patch,
          NOSTR_KIND.pullRequest
        ],
        '#e': ids
      },
      { kinds: [NOSTR_KIND.comment, NOSTR_KIND.pullRequestUpdate], '#E': ids }
    ])
  )
  // A revised series' later patches point at the revision, not the original root.
  const revisionIds = [...addressed, ...related]
    .filter((event) => event.kind === NOSTR_KIND.patch && !rootIds.includes(event.id))
    .map((event) => event.id)
  const revisions = await query(
    repository.relays,
    chunk(revisionIds, ID_CHUNK).map((ids) => ({ kinds: [NOSTR_KIND.patch], '#e': ids }))
  )
  const events = [
    ...new Map([...addressed, ...related, ...revisions].map((event) => [event.id, event])).values()
  ]
  const profiles = await fetchProfiles(query, repository.relays, [
    ...new Set(events.map((event) => event.pubkey))
  ])
  return {
    repository,
    items: projectNostrWorkItems(repository, linkRevisionPatches(events), profiles)
  }
}

// Later patches of a revised series point at the revision; projection looks them up by the root.
function linkRevisionPatches(events: NostrEvent[]): NostrEvent[] {
  const originalOf = new Map(
    events.flatMap((event) => {
      const original =
        event.kind === NOSTR_KIND.patch && isPatchRevision(event)
          ? event.tags.find((t) => t[0] === 'e')?.[1]
          : undefined
      return original ? [[event.id, original] as const] : []
    })
  )
  return events.map((event) => {
    const original =
      event.kind === NOSTR_KIND.patch
        ? originalOf.get(event.tags.find((t) => t[0] === 'e')?.[1] ?? '')
        : undefined
    return original ? { ...event, tags: [...event.tags, ['e', original]] } : event
  })
}

type CachedSnapshot = { expiresAt: number; value: Promise<NostrRepositorySnapshot | null> }

const snapshots = new Map<string, CachedSnapshot>()

export function forgetNostrRepositorySnapshots(): void {
  snapshots.clear()
}

export function getNostrRepositorySnapshot(
  address: NostrRepositoryAddress,
  {
    force = false,
    openSession = openNostrRelaySession
  }: {
    force?: boolean
    openSession?: () => NostrRelaySession
  } = {}
): Promise<NostrRepositorySnapshot | null> {
  const owner = 'pubkey' in address.owner ? address.owner.pubkey : address.owner.nip05
  const key = JSON.stringify([owner, address.identifier, address.relayHints])
  const cached = snapshots.get(key)
  if (cached && !force && cached.expiresAt > Date.now()) {
    return cached.value
  }
  const value = (async () => {
    const pubkey =
      'pubkey' in address.owner
        ? address.owner.pubkey
        : await lookupNip05Pubkey(address.owner.nip05)
    if (!pubkey) {
      throw new Error(`Could not resolve the Nostr address ${owner}.`)
    }
    const session = openSession()
    try {
      return await readNostrRepositorySnapshot(
        session.query,
        pubkey,
        address.identifier,
        address.relayHints
      )
    } finally {
      session.close()
    }
  })()
  const entry = { expiresAt: Date.now() + SNAPSHOT_TTL_MS, value }
  snapshots.delete(key)
  snapshots.set(key, entry)
  // A failed read is retried by the next caller rather than remembered.
  value.catch(() => {
    if (snapshots.get(key) === entry) {
      snapshots.delete(key)
    }
  })
  while (snapshots.size > MAX_CACHED_SNAPSHOTS) {
    snapshots.delete(snapshots.keys().next().value!)
  }
  return value
}
