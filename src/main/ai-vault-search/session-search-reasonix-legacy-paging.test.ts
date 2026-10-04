import { afterEach, expect, it } from 'vitest'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { fakeSearchService } from '../../shared/ai-vault-search-test-fixture'
import { addSyntheticSession, openSessionSearchHarness } from './session-search-engine-test-fixture'
import { createSessionSearchService } from './session-search-service'
import { searchSessionService, setSessionSearchService } from './session-search-service-registry'

const LEGACY_AGENTS = [
  'claude',
  'codebuddy',
  'codex',
  'hermes',
  'pi',
  'omp',
  'prime-agent',
  'cursor',
  'gemini',
  'antigravity',
  'rovo',
  'copilot',
  'opencode',
  'opencode2',
  'zcode',
  'grok',
  'openclaw',
  'devin',
  'droid',
  'cline',
  'kimi',
  'muse'
] as const satisfies readonly AiVaultAgent[]
afterEach(() => setSessionSearchService(null))

it('keeps the conservative current fallback within the exact pre-integration enum', async () => {
  const service = fakeSearchService()
  setSessionSearchService(service)
  for (const transport of ['runtime', 'relay'] as const) {
    service.search.mockClear()
    await searchSessionService({ query: 'needle' }, transport)
    expect(service.search).toHaveBeenCalledExactlyOnceWith(
      {
        query: 'needle',
        limit: 20,
        filters: {
          agents: LEGACY_AGENTS.filter((agent) => agent !== 'codebuddy' && agent !== 'zcode')
        }
      },
      undefined
    )
  }
})

it('excludes unsupported new-agent rows before ranking and paging rather than filtering a returned page', async () => {
  const harness = await openSessionSearchHarness('rx-legacy-paging')
  try {
    addSyntheticSession(harness.db, { id: 1, agent: 'reasonix', updatedAt: '2026-10-03' })
    addSyntheticSession(harness.db, { id: 2, agent: 'dsh', updatedAt: '2026-10-02' })
    addSyntheticSession(harness.db, { id: 3, agent: 'codex', updatedAt: '2026-10-01' })
    addSyntheticSession(harness.db, { id: 4, agent: 'claude', updatedAt: '2026-09-30' })
    addSyntheticSession(harness.db, { id: 5, agent: 'qoder', updatedAt: '2026-10-04' })
    const service = createSessionSearchService({
      engine: harness.engine,
      indexer: {
        reconcile: async () => {},
        status: () => ({
          phase: 'current' as const,
          filesIndexed: 5,
          filesDue: 0,
          filesFailed: 0,
          messagesIndexed: 5,
          degradedRoots: [],
          lastReconcileAt: 1,
          lastSweepCompletedAt: 1,
          sessionsByAgent: {}
        })
      }
    })
    setSessionSearchService(service)
    const first = await searchSessionService(
      { query: 'needle', limit: 1, sort: 'newest' },
      'runtime'
    )
    expect(first).toMatchObject({
      kind: 'results',
      hits: [{ agent: 'codex', sessionId: '3' }],
      page: { hasMore: true }
    })
    if (first.kind !== 'results' || !first.page.cursor) {
      throw new Error('Missing legacy second page')
    }
    const second = await searchSessionService(
      { query: 'needle', limit: 1, sort: 'newest', cursor: first.page.cursor },
      'runtime'
    )
    expect(second).toMatchObject({
      kind: 'results',
      hits: [{ agent: 'claude', sessionId: '4' }],
      page: { hasMore: false, cursor: null }
    })
    const optedIn = await searchSessionService(
      { query: 'needle', limit: 1, sort: 'newest', includeReasonixHistory: true },
      'runtime'
    )
    expect(optedIn).toMatchObject({
      kind: 'results',
      hits: [{ agent: 'reasonix', sessionId: '1' }]
    })
    const qoderOptedIn = await searchSessionService(
      { query: 'needle', limit: 1, sort: 'newest', supportsQoderHistory: true },
      'runtime'
    )
    expect(qoderOptedIn).toMatchObject({
      kind: 'results',
      hits: [{ agent: 'qoder', sessionId: '5' }]
    })
    const unsupportedOnly = await searchSessionService(
      { query: 'needle', filters: { agents: ['reasonix'] } },
      'runtime'
    )
    expect(unsupportedOnly).toMatchObject({
      kind: 'results',
      hits: [],
      page: { cursor: null, hasMore: false }
    })
  } finally {
    await harness.close()
  }
})
