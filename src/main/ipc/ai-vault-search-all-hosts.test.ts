import { expect, it, vi } from 'vitest'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../shared/ai-vault-search-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { searchAllExecutionHosts, type SessionSearchHostLeg } from './ai-vault-search-all-hosts'
import { encodeMergedSearchCursor } from './ai-vault-search-merged-cursor'

/** A host that ranks a fixed list and fences its own cursors on a generation change. */
class StubHost {
  generation = 1
  pages = 0
  lastRequests: AiVaultSearchRequest[] = []

  constructor(
    readonly executionHostId: ExecutionHostId,
    private sessions: readonly { id: string; updatedAt: string | null }[],
    /** Caps this host's own page, the way a smaller remote page size would. */
    private readonly pageSize = Number.POSITIVE_INFINITY
  ) {}

  purge(): void {
    this.sessions = this.sessions.slice(1)
    this.generation += 1
  }

  leg(timeoutMs?: number): SessionSearchHostLeg {
    return {
      executionHostId: this.executionHostId,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      search: (request) => Promise.resolve(this.search(request))
    }
  }

  private search(request: AiVaultSearchRequest): AiVaultSearchResponse {
    this.pages += 1
    this.lastRequests.push(request)
    const limit = Math.min(request.limit ?? 20, this.pageSize)
    let offset = 0
    if (request.cursor !== undefined) {
      const parsed = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'))
      if (parsed.g !== this.generation) {
        return {
          kind: 'stale-cursor',
          generation: this.generation,
          expectedGeneration: parsed.g
        }
      }
      offset = parsed.o
    }
    const page = this.sessions.slice(offset, offset + limit)
    const hasMore = offset + page.length < this.sessions.length
    return {
      kind: 'results',
      hits: page.map((session) => stubHit(session.id, session.updatedAt)),
      page: {
        cursor: hasMore
          ? Buffer.from(
              JSON.stringify({ g: this.generation, o: offset + page.length }),
              'utf8'
            ).toString('base64url')
          : null,
        hasMore
      },
      generation: this.generation,
      truncated: {
        candidates: false,
        snippets: 1,
        query: false,
        freshness: false
      },
      durationMs: 1
    }
  }
}

function stubHit(sessionId: string, updatedAt: string | null): AiVaultSearchHit {
  return {
    agent: 'claude',
    // A host may claim any id; the merge overwrites it with the one it addressed.
    executionHostId: 'ssh:impostor',
    sessionId,
    title: sessionId,
    cwd: null,
    branch: null,
    updatedAt,
    messageCount: 1,
    score: 1,
    source: { presence: 'unverifiable' },
    evidence: null
  }
}

function sessions(prefix: string, count: number, day = 1) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index}`,
    updatedAt: `2026-09-${String(day + index).padStart(2, '0')}T00:00:00.000Z`
  }))
}

function resultsOf(response: AiVaultSearchResponse) {
  if (response.kind !== 'results') {
    throw new Error(`expected results, got ${response.kind}`)
  }
  return response
}

function unavailableLeg(
  executionHostId: ExecutionHostId,
  reason: 'disabled' | 'not-ready' | 'no-service'
): SessionSearchHostLeg {
  return {
    executionHostId,
    search: () => Promise.resolve({ kind: 'unavailable', reason })
  }
}

it('answers an empty merge when no host is reachable to ask', async () => {
  const response = resultsOf(await searchAllExecutionHosts({ query: 'needle' }, []))
  expect(response).toMatchObject({
    hits: [],
    page: { cursor: null, hasMore: false },
    generation: 0,
    hosts: []
  })
})

it('asks every leg for the merged order and passes freshness through unchanged', async () => {
  const host = new StubHost('local', sessions('a', 2))
  await searchAllExecutionHosts(
    {
      query: 'needle',
      freshness: 'wait-until-current',
      filters: { sort: 'newest' },
      debug: true
    },
    [host.leg()]
  )
  expect(host.lastRequests[0]).toEqual({
    query: 'needle',
    freshness: 'wait-until-current',
    filters: { sort: 'newest' }
  })
})

it('forces the merged order onto a leg the caller left to default', async () => {
  const host = new StubHost('local', sessions('a', 2))
  await searchAllExecutionHosts({ query: 'needle' }, [host.leg()])
  expect(host.lastRequests[0]?.filters).toEqual({ sort: 'relevance' })
})

it('stamps every hit with the host the desktop addressed', async () => {
  const host = new StubHost('ssh:box', sessions('a', 2))
  const response = resultsOf(await searchAllExecutionHosts({ query: 'needle' }, [host.leg()]))
  expect(response.hits.map((hit) => hit.executionHostId)).toEqual(['ssh:box', 'ssh:box'])
})

it('merges newest first across hosts, with undated hits last', async () => {
  const left = new StubHost('local', [
    { id: 'l-new', updatedAt: '2026-09-09T00:00:00.000Z' },
    { id: 'l-none', updatedAt: null }
  ])
  const right = new StubHost('ssh:box', [
    { id: 'r-mid', updatedAt: '2026-09-05T00:00:00.000Z' },
    { id: 'r-old', updatedAt: '2026-09-01T00:00:00.000Z' }
  ])
  const response = resultsOf(
    await searchAllExecutionHosts({ query: 'needle', filters: { sort: 'newest' } }, [
      left.leg(),
      right.leg()
    ])
  )
  expect(response.hits.map((hit) => hit.sessionId)).toEqual(['l-new', 'r-mid', 'r-old', 'l-none'])
})

it('breaks a recency tie on execution host id', async () => {
  const at = '2026-09-05T00:00:00.000Z'
  const response = resultsOf(
    await searchAllExecutionHosts({ query: 'needle', filters: { sort: 'newest' } }, [
      new StubHost('ssh:box', [{ id: 'later-host', updatedAt: at }]).leg(),
      new StubHost('local', [{ id: 'earlier-host', updatedAt: at }]).leg()
    ])
  )
  expect(response.hits.map((hit) => hit.sessionId)).toEqual(['earlier-host', 'later-host'])
})

it('rotates hosts by host-id order when merging by relevance', async () => {
  const response = resultsOf(
    await searchAllExecutionHosts({ query: 'needle', limit: 4 }, [
      new StubHost('ssh:box', sessions('b', 3)).leg(),
      new StubHost('local', sessions('a', 3)).leg()
    ])
  )
  expect(response.hits.map((hit) => hit.sessionId)).toEqual(['a-0', 'b-0', 'a-1', 'b-1'])
})

it('reports a host that refuses its own cursor as stale and keeps the merge going', async () => {
  const healthy = new StubHost('local', sessions('a', 6))
  const purged = new StubHost('ssh:box', sessions('b', 6))
  const legs = [healthy.leg(), purged.leg()]
  const first = resultsOf(await searchAllExecutionHosts({ query: 'needle', limit: 4 }, legs))
  purged.purge()
  const second = resultsOf(
    await searchAllExecutionHosts({ query: 'needle', limit: 4, cursor: first.page.cursor! }, legs)
  )
  expect(second.hosts).toEqual([
    { executionHostId: 'local', outcome: 'searched' },
    { executionHostId: 'ssh:box', outcome: 'stale' }
  ])
  expect(second.hits.every((hit) => hit.executionHostId === 'local')).toBe(true)
})

it('names an unavailable host by its reason without losing the other hosts', async () => {
  const healthy = new StubHost('local', sessions('a', 2))
  const response = resultsOf(
    await searchAllExecutionHosts({ query: 'needle' }, [
      healthy.leg(),
      unavailableLeg('ssh:off', 'disabled'),
      unavailableLeg('ssh:cold', 'not-ready'),
      unavailableLeg('runtime:old', 'no-service')
    ])
  )
  expect(response.hosts).toEqual([
    { executionHostId: 'local', outcome: 'searched' },
    { executionHostId: 'runtime:old', outcome: 'no-service' },
    { executionHostId: 'ssh:cold', outcome: 'not-ready' },
    { executionHostId: 'ssh:off', outcome: 'disabled' }
  ])
  expect(response.hits).toHaveLength(2)
  // Nothing more is owed, so a disabled host does not hold the page open.
  expect(response.page.hasMore).toBe(false)
})

it('calls a leg that times out unreachable and retries it on the next page', async () => {
  vi.useFakeTimers()
  try {
    const stalled: SessionSearchHostLeg = {
      executionHostId: 'ssh:slow',
      timeoutMs: 50,
      search: () => new Promise(() => undefined)
    }
    const healthy = new StubHost('local', sessions('a', 2))
    const pending = searchAllExecutionHosts({ query: 'needle' }, [healthy.leg(), stalled])
    await vi.advanceTimersByTimeAsync(60)
    const first = resultsOf(await pending)
    expect(first.hosts).toContainEqual({
      executionHostId: 'ssh:slow',
      outcome: 'unreachable'
    })
    expect(first.page.hasMore).toBe(true)

    const recovered = new StubHost('ssh:slow', sessions('s', 2))
    const second = resultsOf(
      await searchAllExecutionHosts({ query: 'needle', cursor: first.page.cursor! }, [
        healthy.leg(),
        recovered.leg()
      ])
    )
    // The healthy host finished, so only the retried host is still in the walk.
    expect(second.hosts).toEqual([{ executionHostId: 'ssh:slow', outcome: 'searched' }])
    expect(second.hits.map((hit) => hit.sessionId)).toEqual(['s-0', 's-1'])
  } finally {
    vi.useRealTimers()
  }
})

it('reads at most three pages from one host per merged request', async () => {
  // Twelve hits behind pages of two is six host pages; the bound stops at three
  // and the cursor carries the unread page so nothing is lost.
  const host = new StubHost('local', sessions('a', 12), 2)
  const first = resultsOf(
    await searchAllExecutionHosts({ query: 'needle', limit: 10 }, [host.leg()])
  )
  expect(host.pages).toBe(3)
  expect(first.hits.map((hit) => hit.sessionId)).toEqual(['a-0', 'a-1', 'a-2', 'a-3', 'a-4', 'a-5'])
  expect(first.page.hasMore).toBe(true)

  const second = resultsOf(
    await searchAllExecutionHosts({ query: 'needle', limit: 10, cursor: first.page.cursor! }, [
      host.leg()
    ])
  )
  expect(second.hits.map((hit) => hit.sessionId)).toEqual([
    'a-6',
    'a-7',
    'a-8',
    'a-9',
    'a-10',
    'a-11'
  ])
})

it('refuses a cursor that belongs to a different query or host set', async () => {
  const host = new StubHost('local', sessions('a', 6))
  const first = resultsOf(
    await searchAllExecutionHosts({ query: 'needle', limit: 2 }, [host.leg()])
  )
  const refused = [
    { query: 'needle', limit: 4, cursor: first.page.cursor! },
    {
      query: 'needle',
      limit: 2,
      filters: { sort: 'newest' as const },
      cursor: first.page.cursor!
    },
    { query: 'needle', limit: 2, cursor: 'not a cursor' },
    {
      query: 'needle',
      limit: 2,
      cursor: encodeMergedSearchCursor({
        limit: 2,
        sort: 'relevance',
        hosts: { 'ssh:gone': { c: null, e: 0, g: 1 } }
      })
    }
  ]
  for (const request of refused) {
    expect(await searchAllExecutionHosts(request, [host.leg()])).toEqual({
      kind: 'malformed-cursor'
    })
  }
})

it('sums truncation across the hosts it searched', async () => {
  const response = resultsOf(
    await searchAllExecutionHosts({ query: 'needle' }, [
      new StubHost('local', sessions('a', 2)).leg(),
      new StubHost('ssh:box', sessions('b', 2)).leg(),
      unavailableLeg('ssh:off', 'disabled')
    ])
  )
  expect(response.truncated).toEqual({
    candidates: false,
    snippets: 2,
    query: false,
    freshness: false
  })
})
