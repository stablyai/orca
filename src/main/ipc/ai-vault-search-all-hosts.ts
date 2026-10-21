import { resolveSessionSearchLimit } from '../../shared/ai-vault-search-limit'
import type {
  AiVaultSearchHit,
  AiVaultSearchHostOutcome,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../shared/ai-vault-search-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  decodeMergedSearchCursor,
  encodeMergedSearchCursor,
  type MergedSearchCursorEntry
} from './ai-vault-search-merged-cursor'

export type SessionSearchHostLeg = {
  executionHostId: ExecutionHostId
  /** Omitted for the in-process local leg, which has no transport to hang on. */
  timeoutMs?: number
  search: (request: AiVaultSearchRequest) => Promise<AiVaultSearchResponse>
}

type MergedSort = 'relevance' | 'newest'
type HostOutcome = AiVaultSearchHostOutcome['outcome']
type Truncation = {
  candidates: boolean
  snippets: number
  query: boolean
  freshness: boolean
}

// One merged request reads at most this many pages from any single host.
const MAX_HOST_PAGES_PER_REQUEST = 3

type HostWalk = {
  executionHostId: ExecutionHostId
  leg: SessionSearchHostLeg
  request: AiVaultSearchRequest
  outcome: HostOutcome
  cursor: string | null
  emitted: number
  generation: number
  pending: AiVaultSearchHit[]
  nextCursor: string | null
  pages: number
  /** This host still owes hits this request could not read; keep its entry. */
  carry: boolean
  truncated: Truncation
}

/**
 * Fans one query out to every execution host and merges the pages into one.
 *
 * Relevance scores come from independent indexes and are not comparable, so the
 * two orders are the only two that mean anything across hosts: recency, which
 * every host can be asked for directly, and round-robin over each host's own
 * ranking. Legs are walked page by page, so a hit that lost the cut on one page
 * is emitted on the next instead of being dropped.
 */
export async function searchAllExecutionHosts(
  request: AiVaultSearchRequest,
  legs: readonly SessionSearchHostLeg[]
): Promise<AiVaultSearchResponse> {
  const startedAt = Date.now()
  const limit = resolveSessionSearchLimit(request.limit)
  const sort: MergedSort = request.filters?.sort ?? 'relevance'
  const resumed = request.cursor === undefined ? null : decodeMergedSearchCursor(request.cursor)
  if (request.cursor !== undefined) {
    const known = new Set<string>(legs.map((leg) => leg.executionHostId))
    // A cursor belongs to one query over one host set; anything else is not ours.
    if (
      !resumed ||
      resumed.limit !== limit ||
      resumed.sort !== sort ||
      Object.keys(resumed.hosts).some((executionHostId) => !known.has(executionHostId))
    ) {
      return { kind: 'malformed-cursor' }
    }
  }
  // A host absent from the cursor either finished or joined mid-walk; either way
  // it contributes nothing to this page. Host-id order fixes every tiebreak.
  const walks = legs
    .filter((leg) => !resumed || resumed.hosts[leg.executionHostId] !== undefined)
    .map((leg) => newHostWalk(leg, legRequest(request, sort)))
    .sort((left, right) => left.executionHostId.localeCompare(right.executionHostId))
  await Promise.all(
    walks.map((walk) => fetchHostPage(walk, resumed?.hosts[walk.executionHostId] ?? null))
  )
  const hits = await drainMergedPage(walks, limit, sort)
  return mergedSearchResponse(walks, { limit, sort }, hits, Date.now() - startedAt)
}

/** Every leg answers in the merged order; the cursor and debug are this merge's own. */
function legRequest(request: AiVaultSearchRequest, sort: MergedSort): AiVaultSearchRequest {
  const { cursor: _cursor, debug: _debug, ...rest } = request
  return { ...rest, filters: { ...request.filters, sort } }
}

function newHostWalk(leg: SessionSearchHostLeg, request: AiVaultSearchRequest): HostWalk {
  return {
    executionHostId: leg.executionHostId,
    leg,
    request,
    outcome: 'unreachable',
    cursor: null,
    emitted: 0,
    generation: 0,
    pending: [],
    nextCursor: null,
    pages: 0,
    carry: false,
    truncated: {
      candidates: false,
      snippets: 0,
      query: false,
      freshness: false
    }
  }
}

async function fetchHostPage(walk: HostWalk, entry: MergedSearchCursorEntry | null): Promise<void> {
  walk.cursor = entry?.c ?? null
  walk.emitted = entry?.e ?? 0
  walk.generation = entry?.g ?? 0
  walk.pages += 1
  let response: AiVaultSearchResponse
  try {
    const { cursor } = walk
    response = await withLegTimeout(
      walk.leg.search(cursor === null ? walk.request : { ...walk.request, cursor }),
      walk.leg.timeoutMs
    )
  } catch (error) {
    console.error(`[ai-vault-search] ${walk.executionHostId} leg failed:`, error)
    // Keep its place: the next merged page retries this host from here.
    endHostWalk(walk, 'unreachable', true)
    return
  }
  if (response.kind === 'unavailable') {
    endHostWalk(walk, response.reason, false)
    return
  }
  // A cursor this merge minted can only be refused because the host's index
  // moved, so both refusals mean the same thing: this host is done for now.
  if (response.kind !== 'results') {
    endHostWalk(walk, 'stale', false)
    return
  }
  // `e` is an offset into one generation's ranked page, so it is only
  // meaningful while that generation stands. Nothing emitted, nothing to fence.
  if (walk.emitted > 0 && walk.generation !== response.generation) {
    endHostWalk(walk, 'stale', false)
    return
  }
  walk.outcome = 'searched'
  walk.generation = response.generation
  walk.pending = stampExecutionHost(response.hits, walk.executionHostId).slice(walk.emitted)
  walk.nextCursor = response.page.hasMore ? response.page.cursor : null
  walk.carry = false
  walk.truncated.candidates ||= response.truncated.candidates
  walk.truncated.snippets += response.truncated.snippets
  walk.truncated.query ||= response.truncated.query
  walk.truncated.freshness ||= response.truncated.freshness
}

function endHostWalk(walk: HostWalk, outcome: HostOutcome, carry: boolean): void {
  walk.outcome = outcome
  walk.pending = []
  walk.nextCursor = null
  walk.carry = carry
}

async function advanceHostWalk(walk: HostWalk): Promise<void> {
  while (walk.pending.length === 0 && walk.nextCursor !== null) {
    if (walk.pages >= MAX_HOST_PAGES_PER_REQUEST) {
      // Budget spent; the unread page's cursor is already this walk's nextCursor.
      walk.carry = true
      return
    }
    await fetchHostPage(walk, { c: walk.nextCursor, e: 0, g: walk.generation })
  }
}

async function drainMergedPage(
  walks: readonly HostWalk[],
  limit: number,
  sort: MergedSort
): Promise<AiVaultSearchHit[]> {
  const hits: AiVaultSearchHit[] = []
  let turn = 0
  while (hits.length < limit) {
    // Every head must be known before picking, so a lagging host is never skipped.
    for (const walk of walks) {
      await advanceHostWalk(walk)
    }
    const next = sort === 'newest' ? mostRecentWalk(walks) : walkWithTurn(walks, turn)
    if (!next) {
      return hits
    }
    turn = walks.indexOf(next) + 1
    hits.push(next.pending.shift()!)
    next.emitted += 1
  }
  return hits
}

/** Round-robin in host-id order, resuming after whichever host answered last. */
function walkWithTurn(walks: readonly HostWalk[], turn: number): HostWalk | null {
  for (let step = 0; step < walks.length; step++) {
    const walk = walks[(turn + step) % walks.length]
    if (walk && walk.pending.length > 0) {
      return walk
    }
  }
  return null
}

function mostRecentWalk(walks: readonly HostWalk[]): HostWalk | null {
  let best: HostWalk | null = null
  for (const walk of walks) {
    const head = walk.pending[0]
    // Walks are in host-id order, so a strict comparison keeps the first host on a tie.
    if (head && (!best || byRecencyDescending(head, best.pending[0]!) < 0)) {
      best = walk
    }
  }
  return best
}

function mergedSearchResponse(
  walks: readonly HostWalk[],
  query: { limit: number; sort: MergedSort },
  hits: AiVaultSearchHit[],
  durationMs: number
): AiVaultSearchResponse {
  const hosts: AiVaultSearchHostOutcome[] = []
  const nextHosts: Record<string, MergedSearchCursorEntry> = {}
  const truncated: Truncation = {
    candidates: false,
    snippets: 0,
    query: false,
    freshness: false
  }
  for (const walk of walks) {
    hosts.push({
      executionHostId: walk.executionHostId,
      outcome: walk.outcome
    })
    const entry = nextCursorEntry(walk)
    if (entry) {
      nextHosts[walk.executionHostId] = entry
    }
    truncated.candidates ||= walk.truncated.candidates
    truncated.snippets += walk.truncated.snippets
    truncated.query ||= walk.truncated.query
    truncated.freshness ||= walk.truncated.freshness
  }
  const hasMore = Object.keys(nextHosts).length > 0
  const cursor = hasMore ? encodeMergedSearchCursor({ ...query, hosts: nextHosts }) : null
  return {
    kind: 'results',
    hits,
    page: { cursor, hasMore },
    generation: 0,
    truncated,
    durationMs,
    hosts
  }
}

/** Resume where this request stopped: mid-page by skip count, else the unread page. */
function nextCursorEntry(walk: HostWalk): MergedSearchCursorEntry | null {
  if (walk.pending.length > 0) {
    return { c: walk.cursor, e: walk.emitted, g: walk.generation }
  }
  if (walk.nextCursor !== null) {
    return { c: walk.nextCursor, e: 0, g: walk.generation }
  }
  return walk.carry ? { c: walk.cursor, e: walk.emitted, g: walk.generation } : null
}

// This desktop owns which host it addressed; never trust an id the far side returned.
function stampExecutionHost(
  hits: readonly AiVaultSearchHit[],
  executionHostId: ExecutionHostId
): AiVaultSearchHit[] {
  return hits.map((hit) => ({ ...hit, executionHostId }))
}

function byRecencyDescending(left: AiVaultSearchHit, right: AiVaultSearchHit): number {
  const leftMs = updatedAtMs(left)
  const rightMs = updatedAtMs(right)
  if (leftMs === rightMs) {
    return 0
  }
  return leftMs === null ? 1 : rightMs === null ? -1 : rightMs - leftMs
}

function updatedAtMs(hit: AiVaultSearchHit): number | null {
  const parsed = hit.updatedAt === null ? Number.NaN : Date.parse(hit.updatedAt)
  return Number.isNaN(parsed) ? null : parsed
}

async function withLegTimeout<T>(pending: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) {
    return pending
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Session search host timed out.')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
