import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { Issue } from '../../shared/rpc-contract/github-issue-params'

const getIssueMock = vi.hoisted(() => vi.fn())
vi.mock('../github/client', () => ({
  getIssue: getIssueMock,
  getPRCheckDetails: vi.fn(),
  getPRChecks: vi.fn(),
  getPRComments: vi.fn()
}))
vi.mock('../github/work-item-details', () => ({ getPRFileContents: vi.fn() }))

import { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'

const repo: Repo = {
  id: 'repo-1',
  path: '/remote/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  connectionId: 'ssh-1'
}
const ownerRepo = { owner: 'fork', repo: 'repo', host: 'github.com' }

describe('runtime linked issue lookup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('preserves the optional repository through RPC validation', () => {
    expect(Issue.parse({ repo: 'repo-1', number: 247, ownerRepo })).toEqual({
      repo: 'repo-1',
      number: 247,
      ownerRepo
    })
    expect(Issue.parse({ repo: 'repo-1', number: 247 })).toEqual({
      repo: 'repo-1',
      number: 247
    })
  })

  it('passes the saved repository together with the registered execution route', async () => {
    const commands = new RuntimeGitHubReviewQueryCommands({
      resolveRepo: vi.fn().mockResolvedValue(repo),
      getLocalGitArgs: () => [{ wslDistro: 'DevBox' }]
    })
    await commands.getRepoIssue('repo-1', 247, ownerRepo)
    expect(getIssueMock).toHaveBeenCalledWith(
      '/remote/repo',
      247,
      'ssh-1',
      { wslDistro: 'DevBox' },
      ownerRepo
    )
  })

  it('keeps the original call shape when no repository is supplied', async () => {
    const commands = new RuntimeGitHubReviewQueryCommands({
      resolveRepo: vi.fn().mockResolvedValue(repo),
      getLocalGitArgs: () => []
    })
    await commands.getRepoIssue('repo-1', 247)
    expect(getIssueMock).toHaveBeenCalledWith('/remote/repo', 247, 'ssh-1')
  })
})
