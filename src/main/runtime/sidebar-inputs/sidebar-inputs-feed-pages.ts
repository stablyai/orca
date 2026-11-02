import type { SidebarInputsDomainChange } from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'

/** One published entity: its value and that value's JSON, which the feed diffs and measures. */
export type FeedEntity = { value: unknown; json: string; bytes: number }

/** An entity's change: its new form, or null when it was removed. */
export type FeedChange = readonly [domain: string, key: string, entity: FeedEntity | null]

export type FeedPageBody = { domains: Record<string, SidebarInputsDomainChange>; bytes: number }

/** Room left in every page for the reply's other fields; a page token is under 100 bytes. */
export const FEED_PAGE_ENVELOPE_BYTES = 512
// `"name":{"upserts":{},"removals":[],"parts":{}},` less the name.
const DOMAIN_SHELL_BYTES = 44
// Each entry's quotes, colon and comma.
const ENTRY_SHELL_BYTES = 4
// JSON text holds no raw control characters, so a code unit escapes to at most 3 UTF-8 bytes.
const MAX_ESCAPED_BYTES_PER_CODE_UNIT = 3

export function feedEntityFromJson(json: string): FeedEntity {
  return { value: JSON.parse(json), json, bytes: Buffer.byteLength(json, 'utf8') }
}

function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8')
}

/**
 * Splits changes into pages of at most `budgetBytes` encoded, envelope included. An entity too
 * large for any page travels as JSON text parts, each filling its own page.
 */
export function paginateFeedChanges(changes: Iterable<FeedChange>, budgetBytes: number) {
  const room = budgetBytes - FEED_PAGE_ENVELOPE_BYTES
  const pages: FeedPageBody[] = []
  let page: FeedPageBody = { domains: {}, bytes: 0 }
  const domainOf = (name: string): { change: SidebarInputsDomainChange; cost: number } => {
    const existing = page.domains[name]
    return existing
      ? { change: existing, cost: 0 }
      : {
          change: { upserts: {}, removals: [], parts: {} },
          cost: jsonBytes(name) + DOMAIN_SHELL_BYTES
        }
  }
  const place = (
    name: string,
    cost: number,
    write: (change: SidebarInputsDomainChange) => void
  ) => {
    let domain = domainOf(name)
    if (page.bytes + domain.cost + cost > room && page.bytes > 0) {
      pages.push(page)
      page = { domains: {}, bytes: 0 }
      domain = domainOf(name)
    }
    page.domains[name] = domain.change
    page.bytes += domain.cost + cost
    write(domain.change)
  }
  for (const [name, key, entity] of changes) {
    const keyBytes = jsonBytes(key) + ENTRY_SHELL_BYTES
    if (entity === null) {
      place(name, keyBytes, (change) => change.removals.push(key))
    } else if (keyBytes + entity.bytes + jsonBytes(name) + DOMAIN_SHELL_BYTES <= room) {
      place(name, keyBytes + entity.bytes, (change) => {
        change.upserts[key] = entity.value
      })
    } else {
      const partRoom = room - keyBytes - jsonBytes(name) - DOMAIN_SHELL_BYTES - 2
      for (const part of splitJsonText(entity.json, partRoom)) {
        place(name, keyBytes + jsonBytes(part), (change) => {
          change.parts[key] = part
        })
        // Why: a page holds one part of an entity, so the reader joins parts in page order.
        pages.push(page)
        page = { domains: {}, bytes: 0 }
      }
    }
  }
  if (page.bytes > 0 || pages.length === 0) {
    pages.push(page)
  }
  return pages
}

/** Cuts text into pieces whose JSON string form fits `maxBytes`, never inside a surrogate pair. */
function splitJsonText(text: string, maxBytes: number): string[] {
  const units = Math.max(2, Math.floor(maxBytes / MAX_ESCAPED_BYTES_PER_CODE_UNIT))
  const parts: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + units)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1
    }
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}
