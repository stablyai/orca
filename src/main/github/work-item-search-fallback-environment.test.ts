import { expect, it, vi } from 'vitest'
import { api, capture } from './work-item-search-test-harness'
import { listWorkItems } from './client/list/list-work-items'
import { countWorkItems } from './client/list/count-work-items'
import metadata from './__fixtures__/work-item-search-metadata.json'

it('preserves the Search budget floor when the preferred count fails', async () => {
  api.restSearches = 29
  api.aliasErrorRepo = 'fixture/repo'

  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(0)
  expect(api.calls.some((call) => call.args.includes('graphql'))).toBe(true)
  expect(api.calls.some((call) => call.args.some((arg) => arg.startsWith('search/issues?')))).toBe(
    false
  )
  expect(api.restSearches).toBe(29)
})

it('still counts through GraphQL when the REST Search budget is below its floor', async () => {
  api.restSearches = 29

  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(120)
  expect(api.restSearches).toBe(29)
})

it('keeps REST fallback on the credential captured for the failed preferred search', async () => {
  vi.stubEnv('GH_TOKEN', 'fixture-original-credential')
  api.aliasErrorRepo = 'fixture/repo'
  capture.mockImplementation(async (binary, args, options) => {
    if (args.includes('graphql')) {
      vi.stubEnv('GH_TOKEN', 'fixture-later-credential')
    }
    return api.capture(binary, args, options)
  })
  expect((await listWorkItems('fixture/repo', 24, 'is:issue')).items).toHaveLength(24)
  const queries = api.calls.filter(
    (call) =>
      call.args.includes('graphql') || call.args.some((arg) => arg.startsWith('search/issues?'))
  )
  expect(queries.map((call) => call.fixtureCredential)).toEqual([
    'fixture-original-credential',
    'fixture-original-credential'
  ])
})

it('keeps count fallback on its captured credential', async () => {
  vi.stubEnv('GH_TOKEN', 'fixture-original-credential')
  api.aliasErrorRepo = 'fixture/repo'
  capture.mockImplementation(async (binary, args, options) => {
    if (args.includes('graphql')) {
      vi.stubEnv('GH_TOKEN', 'fixture-later-credential')
    }
    return api.capture(binary, args, options)
  })
  expect(await countWorkItems('fixture/repo', 'is:issue')).toBe(120)
  const queries = api.calls.filter(
    (call) =>
      call.args.includes('graphql') || call.args.some((arg) => arg.startsWith('search/issues?'))
  )
  expect(queries.map((call) => call.fixtureCredential)).toEqual([
    'fixture-original-credential',
    'fixture-original-credential'
  ])
})

it('hydrates oversized associations with the preferred page credential', async () => {
  vi.stubEnv('GH_TOKEN', 'fixture-original-credential')
  const row = structuredClone(metadata[0].graphql)
  api.specialNodes = [{ ...row, labels: { ...row.labels, pageInfo: { hasNextPage: true } } }]
  capture.mockImplementation(async (binary, args, options) => {
    if (args.includes('graphql')) {
      vi.stubEnv('GH_TOKEN', 'fixture-later-credential')
    }
    return api.capture(binary, args, options)
  })
  const result = await listWorkItems('fixture/repo', 24, 'is:issue')
  expect(result.items[0].labels).toHaveLength(125)
  const queries = api.calls.filter(
    (call) =>
      call.args.includes('graphql') || call.args.some((arg) => /^repos\/.+\/issues\/\d+$/.test(arg))
  )
  expect(queries.map((call) => call.fixtureCredential)).toEqual([
    'fixture-original-credential',
    'fixture-original-credential'
  ])
})
