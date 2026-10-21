import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const { getIssueMock, listTodosMock } = vi.hoisted(() => ({
  getIssueMock: vi.fn(),
  listTodosMock: vi.fn()
}))
vi.mock('../github/client', () => ({
  getIssue: getIssueMock,
  getPRCheckDetails: vi.fn(),
  getPRChecks: vi.fn(),
  getPRComments: vi.fn()
}))
vi.mock('../github/work-item-details', () => ({ getPRFileContents: vi.fn() }))
vi.mock('../gitlab/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listTodos: listTodosMock
}))

import { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'
import { RuntimeGitLabQueryCommands } from './runtime-gitlab-query-commands'

function repoOn(fields: Pick<Repo, 'connectionId' | 'executionHostId'>): Repo {
  return {
    id: 'repo-1',
    path: '/srv/project',
    displayName: 'project',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...fields
  }
}

// Why: these commands used to pass the raw `connectionId`, so an `ssh:`-only row ran gh/glab here.
describe('runtime provider commands route an SSH project to its host', () => {
  beforeEach(() => {
    getIssueMock.mockReset().mockResolvedValue(null)
    listTodosMock.mockReset().mockResolvedValue([])
  })

  it.each([
    ['executionHostId only', { executionHostId: 'ssh:gpu' as const }, 'gpu'],
    ['legacy connectionId', { connectionId: 'gpu' }, 'gpu'],
    ['local', { executionHostId: 'local' as const }, null]
  ])('GitHub issue lookup (%s)', async (_label, fields, expected) => {
    const commands = new RuntimeGitHubReviewQueryCommands({
      resolveRepo: async () => repoOn(fields),
      getLocalGitArgs: () => []
    })

    await commands.getRepoIssue('id:repo-1', 7)

    expect(getIssueMock).toHaveBeenCalledWith('/srv/project', 7, expected)
  })

  it.each([
    ['executionHostId only', { executionHostId: 'ssh:gpu' as const }, 'gpu'],
    ['local', { executionHostId: 'local' as const }, null]
  ])('GitLab todo list (%s)', async (_label, fields, expected) => {
    const commands = new RuntimeGitLabQueryCommands({
      resolveRepo: async () => repoOn(fields),
      getLocalGitArgs: () => [],
      recordProjectRecent: () => {}
    })

    await commands.listGitLabRepoTodos('id:repo-1')

    expect(listTodosMock).toHaveBeenCalledWith('/srv/project', expected)
  })
})
