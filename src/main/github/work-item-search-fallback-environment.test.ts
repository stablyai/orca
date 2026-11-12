import { expect, it, vi } from 'vitest'
import { api, capture } from './work-item-search-test-harness'
import { listWorkItems } from './client/list/list-work-items'
import './client/list/count-work-items'
import metadata from './__fixtures__/work-item-search-metadata.json'

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
