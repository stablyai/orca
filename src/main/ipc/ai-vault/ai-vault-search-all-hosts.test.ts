import { expect, it, vi } from 'vitest'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../shared/ai-vault/search/ai-vault-search-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { searchAllExecutionHosts, type SessionSearchHostLeg } from './ai-vault-search-all-hosts'

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
    expect(second.hosts).toEqual([{ executionHostId: 'ssh:slow', outcome: 'searched' }])
    expect(second.hits.map((hit) => hit.sessionId)).toEqual(['s-0', 's-1'])
  } finally {
    vi.useRealTimers()
  }
})

it('reads at most three pages from one host per merged request', async () => {
  // Three-page budget stops a six-page host walk; retain its unread cursor for the next merged page.
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
