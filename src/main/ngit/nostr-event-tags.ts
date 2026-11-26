import type { Event } from 'nostr-tools/core'

export type NostrEvent = Event

export function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1]
}

export function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.flatMap((tag) => (tag[0] === name && tag[1] ? [tag[1]] : []))
}

export function hasTag(event: NostrEvent, name: string, value: string): boolean {
  return event.tags.some((tag) => tag[0] === name && tag[1] === value)
}

/** Newest first; the id breaks ties so every client picks the same winner (NIP-01). */
export function byNewest(a: NostrEvent, b: NostrEvent): number {
  return b.created_at - a.created_at || a.id.localeCompare(b.id)
}

/** A later revision of a patch series; early clients wrote the two words the other way round. */
export function isPatchRevision(event: NostrEvent): boolean {
  return hasTag(event, 't', 'root-revision') || hasTag(event, 't', 'revision-root')
}
