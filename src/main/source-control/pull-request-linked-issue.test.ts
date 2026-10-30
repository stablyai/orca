import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPullRequestLinkedIssue } from './pull-request-linked-issue'

const mocks = vi.hoisted(() => ({
  getGitHubIssue: vi.fn(),
  getGitLabIssue: vi.fn()
}))

vi.mock('../github/issues', () => ({ getIssue: mocks.getGitHubIssue }))
vi.mock('../gitlab/issues', () => ({ getIssue: mocks.getGitLabIssue }))

describe('loadPullRequestLinkedIssue', () => {
  beforeEach(() => {
    mocks.getGitHubIssue.mockReset()
    mocks.getGitLabIssue.mockReset()
  })

  it('loads a GitHub issue title and description', async () => {
    mocks.getGitHubIssue.mockResolvedValue({
      number: 12,
      title: 'Stop phantom polling',
      description: 'Do not stat Linux-only paths on macOS.'
    })

    await expect(
      loadPullRequestLinkedIssue({
        meta: { linkedIssue: 12 },
        provider: 'github',
        repoPath: '/repo'
      })
    ).resolves.toEqual({
      provider: 'github',
      number: 12,
      title: 'Stop phantom polling',
      description: 'Do not stat Linux-only paths on macOS.'
    })
  })

  it('loads GitLab details without falling back to the GitHub issue', async () => {
    mocks.getGitLabIssue.mockResolvedValue({
      number: 34,
      title: 'Fix runner polling',
      description: 'The runner checks paths that cannot exist.'
    })

    await expect(
      loadPullRequestLinkedIssue({
        meta: { linkedIssue: 12, linkedGitLabIssue: 34 },
        provider: 'gitlab',
        repoPath: '/repo',
        connectionId: 'ssh-1'
      })
    ).resolves.toMatchObject({ provider: 'gitlab', number: 34, title: 'Fix runner polling' })
    expect(mocks.getGitHubIssue).not.toHaveBeenCalled()
  })

  it('uses persisted work-item title when the provider lookup fails', async () => {
    mocks.getGitHubIssue.mockResolvedValue(null)

    await expect(
      loadPullRequestLinkedIssue({
        meta: {
          linkedIssue: 12,
          linkedWorkItem: {
            provider: 'github',
            type: 'issue',
            number: 12,
            title: 'Cached title',
            url: 'https://github.com/acme/repo/issues/12'
          }
        },
        provider: 'github',
        repoPath: '/repo'
      })
    ).resolves.toMatchObject({ title: 'Cached title', description: '' })
  })

  it('does not attach another provider issue to a Bitbucket PR', async () => {
    await expect(
      loadPullRequestLinkedIssue({
        meta: { linkedIssue: 12, linkedGitLabIssue: 34 },
        provider: 'bitbucket',
        repoPath: '/repo'
      })
    ).resolves.toBeNull()
    expect(mocks.getGitHubIssue).not.toHaveBeenCalled()
    expect(mocks.getGitLabIssue).not.toHaveBeenCalled()
  })
})
