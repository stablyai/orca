import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDefaultRemoteMock, getGitHubApiRepositoryForRemoteMock } = vi.hoisted(() => ({
  getDefaultRemoteMock: vi.fn(),
  getGitHubApiRepositoryForRemoteMock: vi.fn()
}))

vi.mock('../git/repo', () => ({ getDefaultRemote: getDefaultRemoteMock }))
vi.mock('./github-api-repository', () => ({
  getGitHubApiRepositoryForRemote: getGitHubApiRepositoryForRemoteMock
}))

import { resolveGitHubReviewHeadRemote } from './review-head-remote'

function gitExecWithRemotes(remotes: string[]) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'remote') {
      return { stdout: `${remotes.join('\n')}\n`, stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

describe('resolveGitHubReviewHeadRemote', () => {
  beforeEach(() => {
    getDefaultRemoteMock.mockReset()
    getGitHubApiRepositoryForRemoteMock.mockReset()
  })

  it('prefers upstream on a contributor clone whose origin is a fork', async () => {
    // Why: PR work-item resolution probes upstream first; refs/pull/<N>/head for
    // an upstream PR does not exist on the fork origin.
    getGitHubApiRepositoryForRemoteMock.mockImplementation(async (_path, remote) =>
      remote === 'upstream'
        ? { owner: 'org', repo: 'project' }
        : { owner: 'contributor', repo: 'project' }
    )

    const remote = await resolveGitHubReviewHeadRemote({
      repoPath: '/repo',
      gitExec: gitExecWithRemotes(['origin', 'upstream'])
    })

    expect(remote).toBe('upstream')
    expect(getDefaultRemoteMock).not.toHaveBeenCalled()
  })

  it('falls back to origin when upstream is not a GitHub project', async () => {
    getGitHubApiRepositoryForRemoteMock.mockImplementation(async (_path, remote) =>
      remote === 'origin' ? { owner: 'org', repo: 'project' } : null
    )

    const remote = await resolveGitHubReviewHeadRemote({
      repoPath: '/repo',
      gitExec: gitExecWithRemotes(['origin', 'upstream'])
    })

    expect(remote).toBe('origin')
  })

  it('skips identity probes for a single-remote clone and uses the local default', async () => {
    getDefaultRemoteMock.mockResolvedValue('origin')

    const remote = await resolveGitHubReviewHeadRemote({
      repoPath: '/repo',
      localGitOptions: { wslDistro: 'Ubuntu' },
      gitExec: gitExecWithRemotes(['origin'])
    })

    expect(remote).toBe('origin')
    expect(getGitHubApiRepositoryForRemoteMock).not.toHaveBeenCalled()
    expect(getDefaultRemoteMock).toHaveBeenCalledWith('/repo', { wslDistro: 'Ubuntu' })
  })

  it('prefers origin over other remotes on SSH repos when no identity resolves', async () => {
    getGitHubApiRepositoryForRemoteMock.mockResolvedValue(null)

    const remote = await resolveGitHubReviewHeadRemote({
      repoPath: '/remote/repo',
      connectionId: 'ssh-1',
      gitExec: gitExecWithRemotes(['fork', 'origin'])
    })

    expect(remote).toBe('origin')
    expect(getDefaultRemoteMock).not.toHaveBeenCalled()
  })

  it('threads connection and WSL options through the identity probe', async () => {
    getGitHubApiRepositoryForRemoteMock.mockResolvedValue({ owner: 'org', repo: 'project' })

    await resolveGitHubReviewHeadRemote({
      repoPath: '/repo',
      connectionId: 'ssh-1',
      localGitOptions: { wslDistro: 'Ubuntu' },
      gitExec: gitExecWithRemotes(['origin', 'upstream'])
    })

    expect(getGitHubApiRepositoryForRemoteMock).toHaveBeenCalledWith('/repo', 'upstream', 'ssh-1', {
      wslDistro: 'Ubuntu'
    })
  })
})
