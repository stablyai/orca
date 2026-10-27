import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  listProjects: vi.fn(),
  listIssueTypes: vi.fn(),
  listCreateFields: vi.fn(),
  listPriorities: vi.fn(),
  listFavouriteFilters: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../preflight/agent-detection', () => ({ _resetPreflightCache: vi.fn() }))
vi.mock('../../jira/favourite-filters', () => ({
  listFavouriteFilters: mocks.listFavouriteFilters
}))
vi.mock('../../jira/client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getStatus: vi.fn(),
  selectSite: vi.fn(),
  testConnection: vi.fn()
}))
vi.mock('../../jira/jira-issue-mutations', () => ({
  addIssueComment: vi.fn(),
  createIssue: vi.fn(),
  updateIssue: vi.fn()
}))
vi.mock('../../jira/jira-issue-read', () => ({
  getIssue: vi.fn(),
  getIssueSummary: vi.fn()
}))
vi.mock('../../jira/jira-issue-comments', () => ({
  getIssueComments: vi.fn()
}))
vi.mock('../../jira/jira-transition-queries', () => ({
  getProjectStatusOrder: vi.fn(),
  listTransitions: vi.fn()
}))
vi.mock('../../jira/jira-issue-create-metadata', () => ({
  listCreateFields: mocks.listCreateFields,
  listIssueTypes: mocks.listIssueTypes,
  listPriorities: mocks.listPriorities,
  listAssignableUsers: vi.fn(),
  listAssignableUsersForProject: vi.fn(),
  searchUsers: vi.fn()
}))
vi.mock('../../jira/jira-project-queries', () => ({
  listProjects: mocks.listProjects
}))
vi.mock('../../jira/jira-issue-search', () => ({
  listIssues: vi.fn(),
  searchIssues: vi.fn()
}))
import { registerJiraHandlers } from './register-handlers'

function handler(channel: string) {
  const callback = mocks.handle.mock.calls.find(([name]) => name === channel)?.[1]
  if (typeof callback !== 'function') {
    throw new Error(`Missing handler: ${channel}`)
  }
  return callback
}

beforeEach(() => {
  vi.clearAllMocks()
  registerJiraHandlers()
})

describe('Jira project metadata IPC registration', () => {
  it('registers each metadata channel once through the main Jira registration', () => {
    for (const channel of [
      'jira:listProjects',
      'jira:listIssueTypes',
      'jira:listCreateFields',
      'jira:listPriorities',
      'jira:listFavouriteFilters'
    ]) {
      expect(mocks.handle.mock.calls.filter(([name]) => name === channel)).toHaveLength(1)
    }
  })

  it('requires one explicit site for favourite filters and preserves failures', async () => {
    for (const args of [undefined, {}, { siteId: 'all' }, { siteId: ' ' }]) {
      await expect(handler('jira:listFavouriteFilters')(undefined, args)).rejects.toThrow()
    }
    expect(mocks.listFavouriteFilters).not.toHaveBeenCalled()
    const error = new Error('catalogue unavailable')
    mocks.listFavouriteFilters.mockRejectedValueOnce(error)
    await expect(
      handler('jira:listFavouriteFilters')(undefined, { siteId: ' site-1 ' })
    ).rejects.toBe(error)
    expect(mocks.listFavouriteFilters).toHaveBeenCalledExactlyOnceWith('site-1')
  })

  it('retains all-sites selection and site normalization', async () => {
    await handler('jira:listProjects')(undefined, { siteId: ' all ' })
    expect(mocks.listProjects).toHaveBeenLastCalledWith('all')
    await handler('jira:listProjects')(undefined, { siteId: '  ' })
    expect(mocks.listProjects).toHaveBeenLastCalledWith(undefined)
    await handler('jira:listPriorities')(undefined, { siteId: ' site-1 ' })
    expect(mocks.listPriorities).toHaveBeenCalledWith('site-1')
  })

  it('preserves invalid project and issue type sentinels', async () => {
    await expect(
      handler('jira:listIssueTypes')(undefined, { projectIdOrKey: ' ' })
    ).resolves.toEqual([])
    await expect(
      handler('jira:listCreateFields')(undefined, { projectIdOrKey: 'ABC', issueTypeId: 1 })
    ).resolves.toEqual([])
    expect(mocks.listIssueTypes).not.toHaveBeenCalled()
    expect(mocks.listCreateFields).not.toHaveBeenCalled()
  })

  it('forwards trimmed project and issue type identifiers to the same site', async () => {
    await handler('jira:listIssueTypes')(undefined, {
      projectIdOrKey: ' ABC ',
      siteId: ' site-1 '
    })
    expect(mocks.listIssueTypes).toHaveBeenCalledWith('ABC', 'site-1')
    await handler('jira:listCreateFields')(undefined, {
      projectIdOrKey: ' ABC ',
      issueTypeId: ' 10001 ',
      siteId: ' site-1 '
    })
    expect(mocks.listCreateFields).toHaveBeenCalledWith('ABC', '10001', 'site-1')
  })
})
