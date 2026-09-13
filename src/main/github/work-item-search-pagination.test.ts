import { expect, it, vi } from 'vitest'
import { api } from './work-item-search-test-harness'
import { listWorkItems } from './client/list/list-work-items'
import { countWorkItems } from './client/list/count-work-items'

function issuePage(page: number, noCache = false, limit = 24) {
  return listWorkItems(
    'fixture/repo',
    limit,
    'is:issue is:open',
    page,
    undefined,
    undefined,
    noCache
  )
}

it('restores a cold numbered page using only API-issued opaque cursors', async () => {
  const third = await issuePage(3)
  expect(third.items.map((item) => item.number)).toEqual(
    Array.from({ length: 24 }, (_, i) => 9952 - i)
  )
  expect(api.graphqlCalls).toBe(2)
  expect(api.calls[0].args.join(' ')).not.toContain(' nodes {')
  expect(api.calls[1].args.join(' ')).toContain('after: "opaque:1:cursor"')
  expect((await issuePage(4)).items[0].number).toBe(9928)
  expect(api.graphqlCalls).toBe(3)
  expect((await issuePage(6)).items).toEqual([])
  expect(api.restSearches).toBe(0)
})

it('walks long jumps without node hydration and retains the authoritative 1000-result window', async () => {
  api.rowsPerRepo = 1400
  const last = await issuePage(10, false, 100)
  expect(last.items).toHaveLength(100)
  expect(last.items[0].number).toBe(9100)
  expect(api.graphqlCalls).toBe(10)
  expect(api.calls.filter((call) => call.args.join(' ').includes(' nodes {'))).toHaveLength(1)
  expect(await countWorkItems('fixture/repo', 'is:issue is:open')).toBe(1400)
  const outside = await issuePage(11, false, 100)
  expect(outside.items).toEqual([])
  expect(outside.errors?.issues).toMatchObject({
    type: 'validation_error',
    message: 'Invalid request — Only the first 1000 search results are available (HTTP 422)'
  })
  expect(api.restSearches).toBe(1)
})

it('bypasses both page and cursor caches on refresh and expires retained entries', async () => {
  await issuePage(3)
  expect(api.graphqlCalls).toBe(2)
  await issuePage(3)
  expect(api.graphqlCalls).toBe(2)
  await issuePage(3, true)
  expect(api.graphqlCalls).toBe(4)
  expect(api.calls.slice(-2).every((call) => !call.args.includes('--cache'))).toBe(true)
  vi.setSystemTime(120001)
  await issuePage(3)
  expect(api.graphqlCalls).toBe(6)
  expect(api.restSearches).toBe(0)
})

it('does not renew cursor freshness when re-reading a cached page', async () => {
  await issuePage(1)
  vi.setSystemTime(119000)
  await issuePage(1)
  vi.setSystemTime(120001)
  await issuePage(2)
  expect(api.graphqlCalls).toBe(3)
  expect(api.calls[1].args.join(' ')).not.toContain('after:')
})
