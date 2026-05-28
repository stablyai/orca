import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  _resetBitbucketRepoRefCache,
  getBitbucketRepoRef,
  parseBitbucketRepoRef
} from './repository-ref'

describe('Bitbucket repository refs', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetBitbucketRepoRefCache()
  })

  it('parses HTTPS, SSH, and ssh:// Bitbucket remotes', () => {
    expect(parseBitbucketRepoRef('https://bitbucket.org/team/project.git')).toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
    expect(parseBitbucketRepoRef('git@bitbucket.org:team/project.git')).toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
    expect(parseBitbucketRepoRef('ssh://git@bitbucket.org/team/project.git')).toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
    expect(parseBitbucketRepoRef('https://github.com/team/project.git')).toBeNull()
  })

  it('resolves origin through the WSL-aware git runner and caches the result', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@bitbucket.org:team/project.git\n',
      stderr: ''
    })

    await expect(getBitbucketRepoRef('/repo')).resolves.toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
    await expect(getBitbucketRepoRef('/repo')).resolves.toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })
})
