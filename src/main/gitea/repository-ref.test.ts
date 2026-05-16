import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { _resetGiteaRepoRefCache, getGiteaRepoRef, parseGiteaRepoRef } from './repository-ref'

describe('Gitea repository ref parsing', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetGiteaRepoRefCache()
  })

  it('parses HTTPS remotes and derives the API base URL', () => {
    expect(parseGiteaRepoRef('https://git.example.com/team/project.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'project',
      apiBaseUrl: 'https://git.example.com/api/v1',
      webBaseUrl: 'https://git.example.com'
    })
  })

  it('preserves an HTTP subpath when deriving the API base URL', () => {
    expect(parseGiteaRepoRef('https://git.example.com/code/team/project.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'project',
      apiBaseUrl: 'https://git.example.com/code/api/v1',
      webBaseUrl: 'https://git.example.com/code'
    })
  })

  it('parses scp-like SSH remotes with an HTTPS web/API base', () => {
    expect(parseGiteaRepoRef('git@gitea.example.test:team/project.git')).toEqual({
      host: 'gitea.example.test',
      owner: 'team',
      repo: 'project',
      apiBaseUrl: 'https://gitea.example.test/api/v1',
      webBaseUrl: 'https://gitea.example.test'
    })
  })

  it('preserves a scp-like SSH subpath when deriving the API base URL', () => {
    expect(parseGiteaRepoRef('git@gitea.example.test:code/team/project.git')).toEqual({
      host: 'gitea.example.test',
      owner: 'team',
      repo: 'project',
      apiBaseUrl: 'https://gitea.example.test/code/api/v1',
      webBaseUrl: 'https://gitea.example.test/code'
    })
  })

  it('parses ssh:// remotes without carrying the SSH port into web/API URLs', () => {
    expect(parseGiteaRepoRef('ssh://git@gitea.example.test:2222/team/project.git')).toEqual({
      host: 'gitea.example.test',
      owner: 'team',
      repo: 'project',
      apiBaseUrl: 'https://gitea.example.test/api/v1',
      webBaseUrl: 'https://gitea.example.test'
    })
  })

  it('does not claim public hosts handled by more specific providers', () => {
    expect(parseGiteaRepoRef('git@github.com:team/project.git')).toBeNull()
    expect(parseGiteaRepoRef('https://gitlab.com/team/project.git')).toBeNull()
    expect(parseGiteaRepoRef('https://bitbucket.org/team/project.git')).toBeNull()
  })

  it('reads and caches the origin remote', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://git.example.com/team/project.git\n',
      stderr: ''
    })

    await expect(getGiteaRepoRef('/repo')).resolves.toMatchObject({
      host: 'git.example.com',
      owner: 'team',
      repo: 'project'
    })
    await expect(getGiteaRepoRef('/repo')).resolves.toMatchObject({
      host: 'git.example.com',
      owner: 'team',
      repo: 'project'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })
})
