import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, sshExecMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  sshExecMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  _getBitbucketRepoRefCacheSize,
  _resetBitbucketRepoRefCache,
  getBitbucketRepoRefForRemote,
  getBitbucketRepoRef,
  parseBitbucketRepoRef
} from './repository-ref'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

describe('Bitbucket repository refs', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    sshExecMock.mockReset()
    unregisterSshGitProvider('conn-1')
    _resetBitbucketRepoRefCache()
  })

  afterEach(() => {
    unregisterSshGitProvider('conn-1')
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

  it('strips trailing slashes after .git suffixes', () => {
    expect(parseBitbucketRepoRef('https://bitbucket.org/team/project.git/')).toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
    expect(parseBitbucketRepoRef('git@bitbucket.org:team/project.git/')).toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
  })

  it('keeps malformed percent sequences as literal repo path text', async () => {
    expect(parseBitbucketRepoRef('git@bitbucket.org:team/project%zz.git')).toEqual({
      workspace: 'team',
      repoSlug: 'project%zz'
    })

    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@bitbucket.org:team/project%zz.git\n',
      stderr: ''
    })

    await expect(getBitbucketRepoRef('/repo')).resolves.toEqual({
      workspace: 'team',
      repoSlug: 'project%zz'
    })
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

  it('bounds cached repository refs for distinct repo paths', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@bitbucket.org:team/project.git\n',
      stderr: ''
    })

    for (let i = 0; i < 513; i += 1) {
      await getBitbucketRepoRef(`/repo-${i}`)
    }

    expect(_getBitbucketRepoRefCacheSize()).toBe(512)
  })

  it('resolves project refs through the SSH git provider for connected repos', async () => {
    sshExecMock.mockResolvedValueOnce({
      stdout: 'git@bitbucket.org:remote/project.git\n',
      stderr: ''
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getBitbucketRepoRefForRemote('/repo', 'origin', 'conn-1')).resolves.toEqual({
      workspace: 'remote',
      repoSlug: 'project'
    })

    expect(sshExecMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/repo')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not cache transient SSH provider failures as unsupported repos', async () => {
    sshExecMock.mockRejectedValueOnce(new Error('connection closed')).mockResolvedValueOnce({
      stdout: 'git@bitbucket.org:remote/project.git\n',
      stderr: ''
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getBitbucketRepoRefForRemote('/repo', 'origin', 'conn-1')).resolves.toBeNull()
    await expect(getBitbucketRepoRefForRemote('/repo', 'origin', 'conn-1')).resolves.toEqual({
      workspace: 'remote',
      repoSlug: 'project'
    })

    expect(sshExecMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
