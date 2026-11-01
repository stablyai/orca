import { expect, it, vi } from 'vitest'
import { api, capture } from './work-item-search-test-harness'
import { listWorkItems } from './client/list/list-work-items'
import { countWorkItems } from './client/list/count-work-items'
import { searchWorkItemCount, searchWorkItemPage } from './client/list/work-item-search-page'

it('uses the issue page total for a simultaneous or later production count', async () => {
  api.reportedCount = 2748
  const [page, count] = await Promise.all([
    listWorkItems('fixture/repo', 24, 'is:issue is:open'),
    countWorkItems('fixture/repo', 'is:issue is:open')
  ])
  expect(page.items).toHaveLength(24)
  expect(count).toBe(2748)
  expect(api.graphqlCalls).toBe(1)
  expect(api.graphqlFields).toBe(1)
  expect(await countWorkItems('fixture/repo', 'is:issue is:open')).toBe(2748)
  expect(api.graphqlCalls).toBe(1)
  expect(api.restSearches).toBe(0)
})

it('serves a later matching count without another request', async () => {
  api.reportedCount = 2748
  await listWorkItems('fixture/repo', 24, 'is:issue')
  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(2748)
  expect(api.graphqlCalls).toBe(1)
})

it.each([
  'is:pr is:open',
  'is:pr is:closed',
  'is:pr is:draft label:bug',
  'is:pr fix OR feat',
  'is:pr (github OR terminal) AND fix',
  'is:pr "fix ) OR ("',
  String.raw`is:pr "fix \" ) OR ( \" feat"`
])('reuses a rich PR page total for matching counts: %s', async (query) => {
  api.specialNodes = []
  api.reportedCount = 2748
  const [page, count] = await Promise.all([
    listWorkItems('fixture/repo', 24, query),
    countWorkItems('fixture/repo', query)
  ])
  expect(page.items).toEqual([])
  expect(count).toBe(2748)
  expect(api.graphqlCalls).toBe(1)
  expect(api.graphqlFields).toBe(1)
  expect(await countWorkItems('fixture/repo', query)).toBe(2748)
  expect(api.graphqlCalls).toBe(1)
  expect(api.restSearches).toBe(0)
})

it.each(['fix ) OR (', '( fix', '"fix ) OR (', String.raw`fix \") OR (\" open`])(
  'keeps malformed PR count text on the original scoped query: %s',
  async (text) => {
    api.expectedSearch = `repo:fixture/repo is:pull-request ${text}`
    api.reportedCount = 17
    expect(await countWorkItems('fixture/repo', `is:pr ${text}`)).toBe(17)
    expect(api.graphqlCalls).toBe(1)
    expect(api.calls.at(-1)?.args.join(' ')).toContain('search(type: ISSUE,')
    expect(api.restSearches).toBe(0)
  }
)

it('removes count-only aliases before applying the existing batch limit', async () => {
  const pairs = Array.from({ length: 25 }, (_, index) => {
    const search = `repo:fixture/repo-${index} is:issue`
    return [
      searchWorkItemCount(search, {}),
      searchWorkItemPage({ search, nodeSelection: '__typename', limit: 24, page: 1, options: {} })
    ]
  })
  await Promise.all(pairs.flat())
  expect(api.graphqlFields).toBe(25)
  expect(api.graphqlCalls).toBe(3)
})

it('retains a valid total when a page field fails and the list needs REST recovery', async () => {
  capture.mockImplementation(async (binary, args, options) => {
    const result = await api.capture(binary, args, options)
    if (!args.includes('graphql')) {
      return result
    }
    const envelope = JSON.parse(result.stdout)
    const alias = Object.keys(envelope.data).find((key) => /^r\d+$/.test(key))
    envelope.errors = [{ path: [alias, 'nodes', 0, 'title'], message: 'Unavailable title' }]
    throw Object.assign(new Error('Partial GraphQL failure'), {
      stdout: JSON.stringify(envelope),
      stderr: 'Partial GraphQL failure'
    })
  })
  const [page, count] = await Promise.all([
    listWorkItems('fixture/repo', 24, 'is:issue'),
    countWorkItems('fixture/repo', 'is:issue')
  ])
  expect(page.items).toHaveLength(24)
  expect(count).toBe(120)
  expect(api.graphqlFields).toBe(1)
  expect(api.restSearches).toBe(1)
})

it('does not renew the page total when a cached page is read again', async () => {
  await listWorkItems('fixture/repo', 24, 'is:issue')
  vi.setSystemTime(119000)
  await listWorkItems('fixture/repo', 24, 'is:issue')
  api.reportedCount = 121
  vi.setSystemTime(120001)
  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(121)
  expect(api.graphqlCalls).toBe(2)
})

it('keeps forced page reads separate from cached count reads', async () => {
  await listWorkItems('fixture/repo', 24, 'is:issue', 1, undefined, undefined, true)
  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(120)
  expect(api.graphqlCalls).toBe(2)
  expect(api.graphqlFields).toBe(2)
})

it('does not share totals across predicates, credentials or execution scopes', async () => {
  await listWorkItems('fixture/repo', 24, 'is:issue')
  api.reportedCount = 17
  expect(await countWorkItems('fixture/repo', 'is:issue label:bug')).toBe(17)
  expect(await countWorkItems('fixture/other', 'is:issue')).toBe(17)
  vi.stubEnv('GH_TOKEN', 'fixture-new-credential')
  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(17)
  expect(
    await countWorkItems('fixture/repo', 'is:issue', undefined, undefined, { wslDistro: 'Ubuntu' })
  ).toBe(17)
  expect(api.graphqlFields).toBe(5)
})
