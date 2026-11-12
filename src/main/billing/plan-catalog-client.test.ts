import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadPlanCatalog, PLAN_CATALOG_MAX_STALE_MS } from './plan-catalog-client'

const URL_BASE = 'https://billing.test'
const body = {
  schemaVersion: 1,
  catalogVersion: 'c_1',
  plans: [
    {
      id: 'team',
      kind: 'self_serve',
      name: 'Team',
      version: 1,
      features: [],
      prices: [{ interval: 'month', unitAmountCents: 5000, currency: 'usd' }],
      seats: { min: 1, max: 500 },
      checkout: { available: true }
    }
  ]
}

function cacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'plan-catalog-')), 'catalog.json')
}

const ok = (): Response => Response.json(body, { headers: { etag: '"c_1"' } })

describe('loadPlanCatalog', () => {
  it('fetches GET /v1/plans, keeps the last good copy, and revalidates with its ETag', async () => {
    const file = cacheFile()
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => ok())
    const first = await loadPlanCatalog({
      billingApiUrl: URL_BASE,
      cacheFile: file,
      now: 1000,
      fetchImpl
    })
    expect(first).toMatchObject({ status: 'ok', source: 'live', fetchedAt: 1000 })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://billing.test/v1/plans')
    expect(JSON.parse(readFileSync(file, 'utf8')).etag).toBe('"c_1"')

    const notModified = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"c_1"')
      return new Response(null, { status: 304 })
    })
    const second = await loadPlanCatalog({
      billingApiUrl: URL_BASE,
      cacheFile: file,
      now: 2000,
      fetchImpl: notModified
    })
    expect(second).toMatchObject({ status: 'ok', source: 'live', fetchedAt: 2000 })
    if (second.status === 'ok') {
      expect(second.catalog.plans[0]?.id).toBe('team')
    }
  })

  it('reports an older billing service (404) as unsupported', async () => {
    const result = await loadPlanCatalog({
      billingApiUrl: URL_BASE,
      cacheFile: cacheFile(),
      now: 1,
      fetchImpl: async () => Response.json({ error: 'not_found' }, { status: 404 })
    })
    expect(result).toEqual({ status: 'unsupported' })
  })

  it('serves the last copy offline for up to a week, then fails rather than guess', async () => {
    const file = cacheFile()
    await loadPlanCatalog({
      billingApiUrl: URL_BASE,
      cacheFile: file,
      now: 0,
      fetchImpl: async () => ok()
    })
    const offline = async (): Promise<Response> => {
      throw new Error('fetch failed')
    }
    const fresh = await loadPlanCatalog({
      billingApiUrl: URL_BASE,
      cacheFile: file,
      now: PLAN_CATALOG_MAX_STALE_MS - 1,
      fetchImpl: offline
    })
    expect(fresh).toMatchObject({ status: 'ok', source: 'cache', fetchedAt: 0 })
    const stale = await loadPlanCatalog({
      billingApiUrl: URL_BASE,
      cacheFile: file,
      now: PLAN_CATALOG_MAX_STALE_MS,
      fetchImpl: offline
    })
    expect(stale).toEqual({ status: 'failed', error: 'fetch failed' })
    const down = await loadPlanCatalog({
      billingApiUrl: URL_BASE,
      cacheFile: file,
      now: 10,
      fetchImpl: async () => new Response('', { status: 503 })
    })
    expect(down).toMatchObject({ status: 'ok', source: 'cache' })
  })

  it('ignores a copy from another billing origin and an unreadable body', async () => {
    const file = cacheFile()
    await loadPlanCatalog({
      billingApiUrl: URL_BASE,
      cacheFile: file,
      now: 0,
      fetchImpl: async () => ok()
    })
    const other = await loadPlanCatalog({
      billingApiUrl: 'https://other.test',
      cacheFile: file,
      now: 1,
      fetchImpl: async () => new Response('{"schemaVersion":9}', { status: 200 })
    })
    expect(other).toEqual({ status: 'failed', error: 'invalid_plan_catalog' })
    writeFileSync(file, 'not json')
    const broken = await loadPlanCatalog({
      billingApiUrl: URL_BASE,
      cacheFile: file,
      now: 1,
      fetchImpl: async () => ok()
    })
    expect(broken).toMatchObject({ status: 'ok', source: 'live' })
  })
})
