import { expect, it } from 'vitest'
import { api } from './work-item-search-test-harness'
import { listWorkItems } from './client/list/list-work-items'
import { countWorkItems } from './client/list/count-work-items'
import './client/list/work-item-search-page'
import '../git/command-runner/hosted-cli/gh-rate-limit-breaker'

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
