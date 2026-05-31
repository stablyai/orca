import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, sshExecMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  sshExecMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  _resetGiteaRepoRefCache,
  getGiteaRepoRef,
  getGiteaRepoRefForRemote,
  parseGiteaRepoRef
} from './repository-ref'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

describe('Gitea repository ref parsing', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    sshExecMock.mockReset()
    unregisterSshGitProvider('conn-1')
    _resetGiteaRepoRefCache()
  })

  afterEach(() => {
    unregisterSshGitProvider('conn-1')
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
    expect(parseGiteaRepoRef('https://dev.azure.com/team/project/_git/repo')).toBeNull()
    expect(parseGiteaRepoRef('https://team.visualstudio.com/project/_git/repo')).toBeNull()
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

  it('resolves repository refs through the SSH git provider for connected repos', async () => {
    sshExecMock.mockResolvedValueOnce({
      stdout: 'git@gitea.example.test:remote/project.git\n',
      stderr: ''
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getGiteaRepoRefForRemote('/repo', 'origin', 'conn-1')).resolves.toMatchObject({
      host: 'gitea.example.test',
      owner: 'remote',
      repo: 'project'
    })

    expect(sshExecMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/repo')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not cache transient SSH provider failures as unsupported repos', async () => {
    sshExecMock.mockRejectedValueOnce(new Error('connection closed')).mockResolvedValueOnce({
      stdout: 'git@gitea.example.test:remote/project.git\n',
      stderr: ''
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getGiteaRepoRefForRemote('/repo', 'origin', 'conn-1')).resolves.toBeNull()
    await expect(getGiteaRepoRefForRemote('/repo', 'origin', 'conn-1')).resolves.toMatchObject({
      host: 'gitea.example.test',
      owner: 'remote',
      repo: 'project'
    })

    expect(sshExecMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
