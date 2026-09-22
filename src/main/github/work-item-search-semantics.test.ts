import { expect, it } from 'vitest'
import { api } from './work-item-search-test-harness'
import { listWorkItems } from './client/list/list-work-items'
import { countWorkItems } from './client/list/count-work-items'
import { mapIssueWorkItem } from './client/map/work-item'
import metadata from './__fixtures__/work-item-search-metadata.json'

it('matches the saved REST projection for users, bots, avatars, assignees and labels', async () => {
  api.specialNodes = metadata.map((pair) => pair.graphql)
  api.reportedCount = 2748
  const result = await listWorkItems('fixture/repo', 5, 'is:issue')
  expect(result.items).toEqual(metadata.map((pair) => mapIssueWorkItem(pair.rest)))
  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(2748)
  expect(api.restSearches).toBe(0)
})

it('preserves deleted authors and hydrates associations beyond GraphQL connection limits', async () => {
  const row = structuredClone(metadata[0].graphql)
  api.specialNodes = [
    { ...row, author: null, labels: { ...row.labels, pageInfo: { hasNextPage: true } } }
  ]
  const result = await listWorkItems('fixture/repo', 24, 'is:issue')
  expect(result.items).toHaveLength(1)
  expect(result.items[0].author).toBeNull()
  expect(result.items[0].labels).toEqual(
    Array.from({ length: 125 }, (_, index) => `label-${index}`)
  )
  expect(api.restDetails).toBe(1)
  expect(api.restSearches).toBe(0)
})

it('passes every issue predicate to the server for both results and full counts', async () => {
  api.expectedSearch =
    'repo:fixture/repo is:issue is:closed assignee:"some user" author:"some author" label:"needs review" label:bug in:"title,body" "needle phrase"'
  api.specialNodes = [
    { ...metadata[0].graphql, number: 7, state: 'CLOSED', title: 'old needle phrase' }
  ]
  const query =
    'is:issue is:closed assignee:"some user" author:"some author" label:"needs review" label:bug in:"title,body" "needle phrase"'
  expect((await listWorkItems('fixture/repo', 24, query)).items).toMatchObject([
    { number: 7, state: 'closed', title: 'old needle phrase' }
  ])
  expect(await countWorkItems('fixture/repo', query)).toBe(1)
  expect(api.restSearches).toBe(0)
})

it.each([
  ['is:issue state:all', 'repo:fixture/repo is:issue'],
  ['is:issue is:open label:bug', 'repo:fixture/repo is:issue is:open label:bug']
])('retains state/scope semantics for %s', async (query, expected) => {
  api.expectedSearch = expected
  expect((await listWorkItems('fixture/repo', 24, query)).items).toHaveLength(24)
  expect(await countWorkItems('fixture/repo', query)).toBe(120)
  expect(api.restSearches).toBe(0)
})

it.each([
  [
    'is:draft',
    'is:pr is:open draft:true sort:created-desc',
    'repo:fixture/repo is:pull-request is:open draft:true'
  ],
  [
    'is:pr is:closed',
    'is:pr is:closed -is:merged sort:created-desc',
    'repo:fixture/repo is:pull-request is:closed -is:merged'
  ],
  ['is:merged', 'is:pr is:merged sort:created-desc', 'repo:fixture/repo is:pull-request is:merged'],
  [
    'review-requested:"some user" reviewed-by:someone',
    'is:pr review-requested:"some user" reviewed-by:someone sort:created-desc',
    'repo:fixture/repo is:pull-request review-requested:"some user" reviewed-by:someone'
  ]
])('keeps rich PR lists and full count predicates for %s', async (query, prSearch, countSearch) => {
  expect((await listWorkItems('fixture/repo', 24, query)).items).toEqual([])
  expect(api.graphqlCalls).toBe(0)
  expect(api.restSearches).toBe(0)
  expect(api.calls[0].args).toContain(prSearch)
  expect(api.calls[0].args).toContain('--json')
  api.expectedSearch = countSearch
  expect(await countWorkItems('fixture/repo', query)).toBe(120)
  expect(api.graphqlCalls).toBe(1)
})

it('falls back with the original numbered query when GraphQL is unavailable', async () => {
  api.graphqlAvailable = false
  api.expectedSearch = 'repo:fixture/repo is:issue is:closed label:"needs review" "exact phrase"'
  const result = await listWorkItems(
    'fixture/repo',
    24,
    'is:issue is:closed label:"needs review" "exact phrase"',
    3,
    undefined,
    undefined,
    true
  )
  expect(result.items[0].number).toBe(9952)
  const call = api.calls.find((call) => call.args.some((arg) => arg.startsWith('search/issues?')))
  expect(call?.args).toEqual([
    'api',
    '--hostname',
    'github.com',
    `search/issues?q=${encodeURIComponent(api.expectedSearch)}&sort=created&order=desc&per_page=24&page=3`,
    '--jq',
    '.items'
  ])
})

it('falls back for malformed GraphQL rows instead of presenting a truncated result', async () => {
  api.specialNodes = [{ ...metadata[0].graphql, __typename: 'PullRequest' }]
  const result = await listWorkItems('fixture/repo', 24, 'is:issue')
  expect(result.items).toHaveLength(1)
  expect(api.restSearches).toBe(1)
})
