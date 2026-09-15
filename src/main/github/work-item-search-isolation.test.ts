import { expect, it, vi } from 'vitest'
import { api, sourceContext } from './work-item-search-test-harness'
import { listWorkItems } from './client/list/list-work-items'
import { countWorkItems } from './client/list/count-work-items'
import { searchWorkItemCount, usesGraphqlWorkItemSearch } from './client/list/work-item-search-page'
import { recordGhPrimaryRateLimit, ghRateLimitScopeKey } from '../git/gh-rate-limit-breaker'

it('coalesces matching searches and batches independent queries in one execution context', async () => {
  const queries = Array.from({ length: 25 }, (_, i) => `repo:fixture/repo-${i} is:issue`)

  const counts = await Promise.all(
    queries.flatMap((search) => [searchWorkItemCount(search, {}), searchWorkItemCount(search, {})])
  )

  expect(counts).toEqual(Array(50).fill(120))
  expect(api.graphqlCalls).toBe(3)
  expect(api.graphqlFields).toBe(25)
  expect(api.calls.every((call) => call.cwd === undefined)).toBe(true)
})

it('isolates native cwd, WSL distro, host, admission context and inherited credentials', async () => {
  const search = 'repo:fixture/repo is:issue'

  const options = [
    { cwd: 'folder-a' },
    { cwd: 'folder-b' },
    { wslDistro: 'Ubuntu' },
    { wslDistro: 'Debian' },
    { host: 'github.example.com' },
    { admissionTier: 'interactive' as const }
  ]

  await Promise.all(options.map((option) => searchWorkItemCount(search, option)))
  expect(api.graphqlCalls).toBe(options.length)
  await searchWorkItemCount(search, { cwd: 'folder-a' })
  expect(api.graphqlCalls).toBe(options.length)
  vi.stubEnv('GH_TOKEN', 'fixture-rotated-credential')
  await searchWorkItemCount(search, { cwd: 'folder-a' })
  expect(api.graphqlCalls).toBe(options.length + 1)
  expect(api.calls.some((call) => call.args.includes('github.example.com'))).toBe(true)
})

it('keeps SSH GitHub execution client-side without passing remote cwd', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      listWorkItems(`/remote/repo-${i}`, 24, 'is:issue', 1, undefined, `ssh-${i}`)
    )
  )

  expect(results.every((result) => result.items.length === 24)).toBe(true)
  expect(api.graphqlCalls).toBe(2)
  expect(api.calls.every((call) => call.cwd === undefined)).toBe(true)
})

it('leaves GHES on REST and unresolved/non-GitHub sources empty', async () => {
  sourceContext.host = 'github.example.com'
  expect((await listWorkItems('fixture/repo', 24, 'is:issue')).items).toHaveLength(24)
  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(120)
  expect(api.graphqlCalls).toBe(0)
  expect(api.restSearches).toBe(2)
  expect(
    api.calls
      .filter((call) => !call.args.includes('rate_limit'))
      .every((call) => call.args.includes('github.example.com'))
  ).toBe(true)
  expect(
    usesGraphqlWorkItemSearch({ owner: 'fixture', repo: 'repo', host: 'gitlab.com' }, {})
  ).toBe(false)
  sourceContext.available = false
  expect((await listWorkItems('folder/without-git', 24, 'is:issue')).items).toEqual([])
  expect(await countWorkItems('folder/without-git')).toBe(0)
  await expect(
    listWorkItems('/remote/unresolved', 24, 'is:issue', 1, undefined, 'ssh')
  ).rejects.toThrow()
  expect(api.restSearches).toBe(2)
})

it('preserves successful aliases when one repository needs REST fallback', async () => {
  api.aliasErrorRepo = 'fixture/repo-1'

  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      listWorkItems(`/remote/repo-${i}`, 24, 'is:issue', 1, undefined, 'ssh')
    )
  )

  expect(results.every((result) => result.items.length === 24 && !result.errors)).toBe(true)
  expect(api.graphqlCalls).toBe(1)
  expect(api.restSearches).toBe(1)
  expect(
    api.calls
      .find((call) => call.args.some((arg) => arg.startsWith('search/issues?')))
      ?.args.join(' ')
  ).toContain('repo%3Afixture%2Frepo-1')
})

it('falls back on GraphQL quota exhaustion and respects independent runner breaker scopes', async () => {
  recordGhPrimaryRateLimit('graphql', 3600000, ghRateLimitScopeKey('native', 'github.com'))
  expect((await listWorkItems('fixture/repo', 24, 'is:issue')).items).toHaveLength(24)
  expect(api.graphqlCalls).toBe(0)
  expect(api.restSearches).toBe(1)
  expect(
    (
      await listWorkItems('fixture/repo', 24, 'is:issue', 1, undefined, undefined, false, {
        wslDistro: 'Ubuntu'
      })
    ).items
  ).toHaveLength(24)
  expect(api.graphqlCalls).toBe(1)
  expect(api.restSearches).toBe(1)
})

it('keeps count/list search usable when REST Search is exhausted and reports both-bucket failures', async () => {
  api.searchAvailable = false
  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(120)
  expect((await listWorkItems('fixture/repo', 24, 'is:issue')).items).toHaveLength(24)
  expect(api.restSearches).toBe(0)
  api.graphqlAvailable = false
  await expect(
    listWorkItems('fixture/repo', 24, 'is:issue', 1, undefined, undefined, true)
  ).rejects.toThrow(/rate limit exceeded/)
})

it('splits long search predicates within Windows command-line headroom', async () => {
  const queries = Array.from(
    { length: 4 },
    (_, index) => `repo:fixture/repo-${index} is:issue ${'word '.repeat(1400)}`
  )

  expect(await Promise.all(queries.map((query) => searchWorkItemCount(query, {})))).toEqual([
    120, 120, 120, 120
  ])
  expect(api.graphqlCalls).toBe(4)
  expect(api.calls.every((call) => call.args.join(' ').length < 12000)).toBe(true)
})

it('executes queued requests with the credential environment captured at enqueue time', async () => {
  vi.stubEnv('GH_TOKEN', 'fixture-first-credential')
  const first = searchWorkItemCount('repo:fixture/repo is:issue', {})
  vi.stubEnv('GH_TOKEN', 'fixture-second-credential')
  const second = searchWorkItemCount('repo:fixture/repo is:issue', {})
  expect(await Promise.all([first, second])).toEqual([120, 120])
  expect(api.graphqlCalls).toBe(2)
  expect(api.calls.map((call) => call.fixtureCredential)).toEqual([
    'fixture-first-credential',
    'fixture-second-credential'
  ])
})
