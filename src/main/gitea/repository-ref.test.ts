import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, teaExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  teaExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  teaExecFileAsync: teaExecFileAsyncMock
}))

import {
  _getGiteaRepoRefCacheSize,
  _resetGiteaRepoRefCache,
  getGiteaRepoRef,
  getGiteaRepoRefForRemote,
  parseGiteaRepoRef,
  teaRepoArgs
} from './repository-ref'
import { _resetTeaKnownHostsCache } from './gitea-known-host-probe'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from '../git/remote-url-probe'

const OLD_ENV = process.env

const WORK_LOGIN = {
  name: 'work',
  url: 'https://gitea.example.com:3000/gitea',
  ssh_host: 'ssh.gitea.example.com:2222',
  user: 'octo',
  default: true
}

describe('Gitea repository ref parsing', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_GITEA_API_BASE_URL
    delete process.env.GITEA_INSTANCE_URL
    gitExecFileAsyncMock.mockReset()
    teaExecFileAsyncMock.mockReset()
    teaExecFileAsyncMock.mockRejectedValue(new Error('tea missing'))
    _resetGiteaRepoRefCache()
    _resetTeaKnownHostsCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
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

  it('strips trailing slashes after .git suffixes', () => {
    expect(parseGiteaRepoRef('https://git.example.com/team/project.git/')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'project',
      apiBaseUrl: 'https://git.example.com/api/v1',
      webBaseUrl: 'https://git.example.com'
    })
    expect(parseGiteaRepoRef('git@gitea.example.test:team/project.git/')).toMatchObject({
      host: 'gitea.example.test',
      owner: 'team',
      repo: 'project'
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
    expect(parseGiteaRepoRef('git@ssh.bitbucket.org:team/project.git')).toBeNull()
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
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
    })
  })

  it('bounds cached repository refs for distinct repo paths', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://git.example.com/team/project.git\n',
      stderr: ''
    })

    for (let i = 0; i < 513; i += 1) {
      await getGiteaRepoRef(`/repo-${i}`)
    }

    expect(_getGiteaRepoRefCacheSize()).toBe(512)
  })

  it('matches a custom SSH host and web subpath to the tea login', async () => {
    teaExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify([WORK_LOGIN]),
      stderr: ''
    })
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'ssh://git@ssh.gitea.example.com:2222/gitea/team/project.git\n',
      stderr: ''
    })

    const repoRef = await getGiteaRepoRefForRemote('/repo', 'origin')

    expect(repoRef).toEqual({
      host: 'gitea.example.com',
      owner: 'team',
      repo: 'project',
      apiBaseUrl: 'https://gitea.example.com:3000/gitea/api/v1',
      webBaseUrl: 'https://gitea.example.com:3000/gitea',
      loginName: 'work'
    })
    expect(teaRepoArgs(repoRef!)).toEqual(['--repo', 'team/project', '--login', 'work'])
  })

  it('matches an HTTPS remote on the login URL port and subpath', async () => {
    teaExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify([WORK_LOGIN]),
      stderr: ''
    })
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://gitea.example.com:3000/gitea/team/project.git\n',
      stderr: ''
    })

    await expect(getGiteaRepoRefForRemote('/repo', 'origin')).resolves.toEqual({
      host: 'gitea.example.com',
      owner: 'team',
      repo: 'project',
      apiBaseUrl: 'https://gitea.example.com:3000/gitea/api/v1',
      webBaseUrl: 'https://gitea.example.com:3000/gitea',
      loginName: 'work'
    })
  })

  it('matches an scp remote whose host is the login SSH hostname', async () => {
    teaExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify([WORK_LOGIN]),
      stderr: ''
    })
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@ssh.gitea.example.com:gitea/team/project.git\n',
      stderr: ''
    })

    await expect(getGiteaRepoRefForRemote('/repo', 'origin')).resolves.toMatchObject({
      owner: 'team',
      repo: 'project',
      webBaseUrl: 'https://gitea.example.com:3000/gitea',
      loginName: 'work'
    })
  })

  it('does not treat GitHub Enterprise or self-hosted GitLab as Gitea when a login is configured', async () => {
    teaExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify([WORK_LOGIN]),
      stderr: ''
    })

    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://github.company.com/org/repo.git\n',
      stderr: ''
    })
    await expect(getGiteaRepoRefForRemote('/ghe', 'origin')).resolves.toBeNull()

    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://gitlab.company.com/group/project.git\n',
      stderr: ''
    })
    await expect(getGiteaRepoRefForRemote('/gitlab', 'origin')).resolves.toBeNull()
  })

  it('rejects a login web host when the HTTP port or subpath differs', async () => {
    teaExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify([WORK_LOGIN]),
      stderr: ''
    })

    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://gitea.example.com/gitea/team/project.git\n',
      stderr: ''
    })
    await expect(getGiteaRepoRefForRemote('/port', 'origin')).resolves.toBeNull()

    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://gitea.example.com:3000/other/team/project.git\n',
      stderr: ''
    })
    await expect(getGiteaRepoRefForRemote('/subpath', 'origin')).resolves.toBeNull()
  })

  it('uses the instance URL host and omits --login when tea has no stored login', async () => {
    process.env.ORCA_GITEA_API_BASE_URL = 'https://git.example.com:3000/api/v1'
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://git.example.com:3000/team/project.git\n',
      stderr: ''
    })

    const repoRef = await getGiteaRepoRefForRemote('/repo', 'origin')

    expect(repoRef).toMatchObject({
      host: 'git.example.com',
      owner: 'team',
      repo: 'project',
      webBaseUrl: 'https://git.example.com:3000'
    })
    expect(repoRef?.loginName ?? null).toBeNull()
    expect(teaRepoArgs(repoRef!)).toEqual(['--repo', 'team/project'])

    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://git.example.com/team/project.git\n',
      stderr: ''
    })
    await expect(getGiteaRepoRefForRemote('/other-port', 'origin')).resolves.toBeNull()
  })

  it('matches GITEA_INSTANCE_URL when the Orca API base is unset and rejects other forges', async () => {
    process.env.GITEA_INSTANCE_URL = 'https://codeberg.org'
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@codeberg.org:team/project.git\n',
      stderr: ''
    })
    await expect(getGiteaRepoRefForRemote('/repo', 'origin')).resolves.toMatchObject({
      host: 'codeberg.org',
      owner: 'team',
      repo: 'project'
    })

    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://gitlab.company.com/group/project.git\n',
      stderr: ''
    })
    await expect(getGiteaRepoRefForRemote('/gitlab', 'origin')).resolves.toBeNull()
  })
})
