import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import {
  dirEntryPageAfter,
  FILE_READ_DIR_MAX_PAGE_ENTRIES,
  type DirEntryCursor,
  type DirEntryPage
} from '../../../../shared/file-dir-page'

/** Long enough to page through a folder as it scrolls; the cursor keeps an older listing correct. */
export const DIR_LISTING_PAGE_CACHE_TTL_MS = 30_000
const MAX_CACHED_LISTINGS = 8
/** Past this, a folder's listing is held alone, evicting every other. */
const MAX_CACHED_ENTRIES = 200_000
/** Past this, a folder is never held: each page lists it again, deduped while in flight. */
const MAX_HELD_LISTING_ENTRIES = 1_000_000

type DirPageRequest = {
  worktree: string
  relativePath: string
  followSymlinks?: boolean
  after?: DirEntryCursor
  limit?: number
}

type CachedListing = {
  workspace: string
  entries: DirEntry[]
  listedAt: number
  expiry?: ReturnType<typeof setTimeout>
}

/** `id:X` and `X` name one workspace; the desktop's watch and reads both send `id:`. */
function workspaceKey(worktree: string): string {
  const trimmed = worktree.trim()
  return trimmed.startsWith('id:') ? trimmed.slice(3) : trimmed
}

/**
 * Host-wide, keyed per (connection, folder): 8 listings and 200k entries across all clients, so
 * later pages skip re-listing. Pages start after a cursor, not at an offset: a listing that
 * expired, was evicted or changed between pages never skips or repeats an entry, so this cache
 * only saves work.
 */
export class DirListingPageCache {
  private readonly listings = new Map<string, CachedListing>()
  private readonly inFlight = new Map<string, Promise<DirEntry[]>>()
  private cachedEntries = 0

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Entries held across every cached listing. */
  get heldEntryCount(): number {
    return this.cachedEntries
  }

  /** Page one always re-lists, so a refresh never reads a listing older than itself. */
  async readPage(
    connectionId: string | undefined,
    request: DirPageRequest,
    list: () => Promise<DirEntry[]>
  ): Promise<DirEntryPage> {
    // Why per connection: a socket that never listed this folder cannot read another's snapshot.
    const key =
      connectionId === undefined
        ? null
        : JSON.stringify([
            connectionId,
            request.worktree,
            request.relativePath,
            request.followSymlinks === true
          ])
    const cached = key !== null && request.after ? this.take(key) : null
    const listing = cached ?? {
      workspace: workspaceKey(request.worktree),
      entries: await this.listOnce(key, list),
      listedAt: this.now()
    }
    const page = dirEntryPageAfter(
      listing.entries,
      request.after,
      request.limit ?? FILE_READ_DIR_MAX_PAGE_ENTRIES
    )
    if (key !== null) {
      this.remember(key, listing, page.hasMore)
    }
    return page
  }

  /** The host's watcher saw a change in this workspace: drop its listings so none outlives it. */
  forgetWorkspace(worktree: string): void {
    const workspace = workspaceKey(worktree)
    for (const [key, listing] of this.listings) {
      if (listing.workspace === workspace) {
        this.forget(key)
      }
    }
  }

  /** Concurrent reads of one folder on one connection share a single listing. */
  private listOnce(key: string | null, list: () => Promise<DirEntry[]>): Promise<DirEntry[]> {
    if (key === null) {
      return list()
    }
    const pending = this.inFlight.get(key)
    if (pending) {
      return pending
    }
    const listing = list().finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, listing)
    return listing
  }

  private take(key: string): CachedListing | null {
    this.sweepExpired()
    return this.listings.get(key) ?? null
  }

  // Why: an abandoned scroll must not keep up to 200k entries resident until the next eviction.
  private sweepExpired(): void {
    const now = this.now()
    for (const [key, listing] of this.listings) {
      if (now - listing.listedAt >= DIR_LISTING_PAGE_CACHE_TTL_MS) {
        this.forget(key)
      }
    }
  }

  private remember(key: string, listing: CachedListing, morePages: boolean): void {
    this.forget(key)
    this.sweepExpired()
    if (!morePages || listing.entries.length > MAX_HELD_LISTING_ENTRIES) {
      return
    }
    const remaining = DIR_LISTING_PAGE_CACHE_TTL_MS - (this.now() - listing.listedAt)
    // Why a timer: with no further reads, nothing else would release the listing.
    const expiry = setTimeout(() => this.forget(key), Math.max(0, remaining))
    expiry.unref?.()
    this.listings.set(key, { ...listing, expiry })
    this.cachedEntries += listing.entries.length
    // An oversized listing stays as the only one, so its pages and refresh cost one listing.
    for (const oldest of this.listings.keys()) {
      if (
        oldest === key ||
        (this.listings.size <= MAX_CACHED_LISTINGS && this.cachedEntries <= MAX_CACHED_ENTRIES)
      ) {
        break
      }
      this.forget(oldest)
    }
  }

  private forget(key: string): void {
    const listing = this.listings.get(key)
    if (listing) {
      clearTimeout(listing.expiry)
      this.listings.delete(key)
      this.cachedEntries -= listing.entries.length
    }
  }
}

export const dirListingPageCache = new DirListingPageCache()
