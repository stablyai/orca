import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), searchIssues: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../jira/jira-issue-search', () => ({
  listIssues: vi.fn(),
  searchIssues: mocks.searchIssues
}))

import { registerJiraHandlers } from './register-handlers'

beforeEach(() => {
  vi.clearAllMocks()
  registerJiraHandlers()
})

it('validates and forwards numeric suggestions through the cancellable local search handler', async () => {
  const search = mocks.handle.mock.calls.find(([name]) => name === 'jira:searchIssues')?.[1]
  if (typeof search !== 'function') {
    throw new Error('Missing Jira search handler')
  }
  await expect(
    search(undefined, {
      jql: 'text ~ "400*"',
      suggestions: { query: '400 OR 1=1', currentJql: 'ORDER BY updated DESC' }
    })
  ).rejects.toThrow()
  expect(mocks.searchIssues).not.toHaveBeenCalled()

  const suggestions = { query: '400', currentJql: 'sprint in openSprints()' }
  mocks.searchIssues.mockResolvedValueOnce([{ key: 'ABC-400' }])
  await expect(
    search(undefined, { jql: 'text ~ "400*"', siteId: 'site-a', suggestions })
  ).resolves.toEqual([{ key: 'ABC-400' }])
  expect(mocks.searchIssues).toHaveBeenCalledExactlyOnceWith(
    'text ~ "400*"',
    30,
    'site-a',
    expect.any(AbortSignal),
    false,
    suggestions
  )
})
