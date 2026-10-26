import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  _getBitbucketRepoRefCacheSize,
  _resetBitbucketRepoRefCache,
  getBitbucketRepoRef,
  parseBitbucketRepoRef
} from './repository-ref'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from '../git/remote-url-probe'

describe('Bitbucket repository refs', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetBitbucketRepoRefCache()
  })

  afterEach(() => {})

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
    expect(parseBitbucketRepoRef('git@ssh.bitbucket.org:team/project.git')).toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
    expect(parseBitbucketRepoRef('ssh://git@ssh.bitbucket.org/team/project.git')).toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
    expect(parseBitbucketRepoRef('https://github.com/team/project.git')).toBeNull()
  })

  it('recognizes the SSH host case-insensitively without accepting lookalike hosts', () => {
    expect(parseBitbucketRepoRef('git@SSH.BITBUCKET.ORG:team/project.git')).toEqual({
      workspace: 'team',
      repoSlug: 'project'
    })
    expect(parseBitbucketRepoRef('git@ssh.bitbucket.org.example.com:team/project.git')).toBeNull()
    expect(
      parseBitbucketRepoRef('ssh://git@ssh.bitbucket.org.example.com/team/project.git')
    ).toBeNull()
    expect(parseBitbucketRepoRef('git@notssh.bitbucket.org:team/project.git')).toBeNull()
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
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
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
})
