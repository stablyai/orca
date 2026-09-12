import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openSessionSearchHarness,
  addSyntheticSession,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import { createSessionSearchService } from './session-search-service'
import {
  AiVaultSearchResponseSchema,
  AiVaultSearchStatusSchema
} from '../../shared/ai-vault-search-contract'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'

let harness: SessionSearchHarness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function fixture() {
  harness = await openSessionSearchHarness('public-contract')
  const { enabled: _enabled, generation: _generation, ...status } = unavailableSessionSearchStatus()
  const indexer = { status: () => status, reconcile: vi.fn(async () => {}) }
  const service = createSessionSearchService({ engine: harness.engine, indexer })
  return { ...harness, service, indexer }
}

describe('real index to public service adapter', () => {
  it('pages a real store, maps evidence and diagnostics, and rejects stale or malformed cursors', async () => {
    const { db, store, service } = await fixture()
    addSyntheticSession(db, { id: 1 })
    addSyntheticSession(db, { id: 2, filePath: null })
    const first = await service.search({ query: 'needle', limit: 1, debug: true })
    expect(AiVaultSearchResponseSchema.parse(first)).toEqual(first)
    expect(first.kind).toBe('results')
    if (first.kind !== 'results') {
      throw new Error('Expected results')
    }
    expect(first.debug?.plannerReport.scope).toBe('all')
    expect(first).not.toHaveProperty('route')
    expect(first).not.toHaveProperty('tier')
    expect(first.page.hasMore).toBe(true)
    const next = await service.search({ query: 'needle', cursor: first.page.cursor!, limit: 1 })
    expect(next.kind).toBe('results')
    if (next.kind !== 'results') {
      throw new Error('Expected results')
    }
    expect(next.hits[0].sessionId).not.toBe(first.hits[0].sessionId)
    expect(next).not.toHaveProperty('debug')
    const hits = [...first.hits, ...next.hits]
    expect(hits.find((hit) => hit.source.presence === 'present')?.resumeCommand).toBe('resume')
    expect(hits.find((hit) => hit.source.presence === 'unverifiable')).not.toHaveProperty(
      'resumeCommand'
    )
    expect(await service.search({ query: 'other', cursor: first.page.cursor! })).toEqual({
      kind: 'malformed-cursor'
    })
    await store.purgeOlderThan(1740000000001)
    expect(await service.search({ query: 'needle', cursor: first.page.cursor! })).toMatchObject({
      kind: 'stale-cursor',
      expectedGeneration: first.generation
    })
    expect(await service.search({ query: 'needle', cursor: '' })).toEqual({
      kind: 'malformed-cursor'
    })
    expect(await service.search({ query: 'needle', cursor: 'garbage' })).toEqual({
      kind: 'malformed-cursor'
    })
    expect(await service.search({ query: 'needle' })).toMatchObject({
      kind: 'results',
      hits: [expect.objectContaining({ sessionId: '2' })]
    })
  })
  it('preserves null evidence for folder operators and delegates recent reconciliation', async () => {
    const { db, service, indexer } = await fixture()
    addSyntheticSession(db, { id: 1, cwd: '/folder/no-git-required' })
    const result = await service.search({ query: 'path:no-git-required' })
    expect(result).toMatchObject({
      kind: 'results',
      hits: [expect.objectContaining({ evidence: null })]
    })
    await service.reconcile()
    expect(indexer.reconcile).toHaveBeenCalledExactlyOnceWith({ full: false })
    const status = await service.status()
    expect(AiVaultSearchStatusSchema.parse(status)).toEqual(status)
    expect(status.generation).toBeGreaterThan(0)
  })
  it('keeps tool text out of conversation scope and reports query truncation', async () => {
    const { db, service } = await fixture()
    addSyntheticSession(db, { id: 1, role: 'tool', text: 'needle' })
    expect(await service.search({ query: 'needle', scope: 'conversation' })).toMatchObject({
      kind: 'results',
      hits: []
    })
    expect(await service.search({ query: 'needle' })).toMatchObject({
      kind: 'results',
      hits: [expect.anything()]
    })
    expect(await service.search({ query: 'needle '.repeat(100) })).toMatchObject({
      kind: 'results',
      truncated: { query: true }
    })
  })
})
