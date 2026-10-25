import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getClients, jiraRequest, acquire, release } = vi.hoisted(() => ({
  getClients: vi.fn(),
  jiraRequest: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn()
}))
vi.mock('./client', () => ({ getClients, clearToken: vi.fn(), isAuthError: () => false }))
vi.mock('./authenticated-request', () => ({
  apiBasePath: () => '/rest/api/3',
  jiraRequest,
  jiraRequestBinary: vi.fn(),
  JiraApiError: class extends Error {}
}))
vi.mock('./jira-agile-fields', () => ({
  getAgileFieldIds: async () => ({}),
  agileFieldIdList: () => []
}))
vi.mock('./request-queue', () => ({ acquire, release }))

import { listIssues, searchIssues } from './jira-issue-search'
import { getIssue } from './jira-issue-read'
import { getIssueComments } from './jira-issue-comments'
import { listProjects } from './jira-project-queries'
import {
  listIssueTypes,
  listCreateFields,
  listPriorities,
  listAssignableUsers
} from './jira-issue-create-metadata'
import { listTransitions } from './jira-transition-queries'

const entry = {
  site: {
    id: 'site-1',
    siteUrl: 'https://example.atlassian.net',
    email: '',
    displayName: 'Jira',
    accountId: 'user-1'
  },
  authorization: 'Basic test'
}
const readers = [
  ['list', (strict: boolean) => listIssues('assigned', 30, 'site-1', strict), []],
  [
    'search',
    (strict: boolean) => searchIssues('project = ENG', 30, 'site-1', undefined, strict),
    []
  ],
  ['issue', (strict: boolean) => getIssue('ENG-1', 'site-1', strict), null],
  ['comments', (strict: boolean) => getIssueComments('ENG-1', 'site-1', strict), []],
  ['projects', (strict: boolean) => listProjects('site-1', strict), []],
  ['issue types', (strict: boolean) => listIssueTypes('ENG', 'site-1', strict), []],
  ['create fields', (strict: boolean) => listCreateFields('ENG', '1', 'site-1', strict), []],
  ['priorities', (strict: boolean) => listPriorities('site-1', strict), []],
  ['assignees', (strict: boolean) => listAssignableUsers('ENG-1', undefined, 'site-1', strict), []],
  ['transitions', (strict: boolean) => listTransitions('ENG-1', 'site-1', strict), []]
] as const

describe('verified Jira agent reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClients.mockReturnValue([entry])
    acquire.mockResolvedValue(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it.each(readers)(
    'surfaces real request failures for %s while preserving older callers',
    async (_name, read, legacyEmpty) => {
      const error = new Error('Jira 403: permission denied')
      jiraRequest.mockRejectedValue(error)
      await (_name === 'list' || _name === 'search'
        ? expect(read(false)).rejects.toBe(error)
        : expect(read(false)).resolves.toEqual(legacyEmpty))
      await expect(read(true)).rejects.toBe(error)
      expect(release).toHaveBeenCalledTimes(2)
    }
  )

  it.each(readers)(
    'rejects disconnected verified %s reads before requesting Jira',
    async (_name, read) => {
      getClients.mockReturnValue([])
      await expect(read(true)).rejects.toThrow('one connected site ID')
      expect(jiraRequest).not.toHaveBeenCalled()
    }
  )

  it('distinguishes a successfully empty comment list from a failed read', async () => {
    jiraRequest.mockResolvedValue({ comments: [], total: 0 })
    await expect(getIssueComments('ENG-1', 'site-1', true)).resolves.toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('refuses all-site strict reads even with one connected site', async () => {
    await expect(getIssue('ENG-1', 'all', true)).rejects.toThrow('one connected site ID')
    expect(jiraRequest).not.toHaveBeenCalled()
  })
})
