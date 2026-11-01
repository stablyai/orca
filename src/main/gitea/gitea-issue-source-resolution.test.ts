import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, teaExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  teaExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  teaExecFileAsync: teaExecFileAsyncMock
}))

import { resolveGiteaIssueSource } from './gitea-issue-source-resolution'
import { _resetGiteaRepoRefCache } from './repository-ref'
import { _resetTeaKnownHostsCache } from './gitea-known-host-probe'
import { _resetRemoteNameListingCache } from '../git/remote-name-listing'

const OLD_ENV = process.env

function mockRemotes(remotes: Record<string, string>): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: `${Object.keys(remotes).join('\n')}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const url = remotes[args[2] ?? '']
      if (!url) {
        throw new Error(`missing remote ${args[2]}`)
      }
      return { stdout: `${url}\n`, stderr: '' }
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  })
}

describe('resolveGiteaIssueSource', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_GITEA_API_BASE_URL
    delete process.env.GITEA_INSTANCE_URL
    gitExecFileAsyncMock.mockReset()
    teaExecFileAsyncMock.mockReset()
    teaExecFileAsyncMock.mockRejectedValue(new Error('tea missing'))
    _resetGiteaRepoRefCache()
    _resetTeaKnownHostsCache()
    _resetRemoteNameListingCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('uses origin when the preference is origin, including on a fork', async () => {
    mockRemotes({
      origin: 'https://git.example.com/me/fork.git',
      upstream: 'https://git.example.com/org/project.git'
    })

    await expect(resolveGiteaIssueSource('/fork', 'origin')).resolves.toEqual({
      source: {
        host: 'git.example.com',
        owner: 'me',
        repo: 'fork',
        apiBaseUrl: 'https://git.example.com/api/v1',
        webBaseUrl: 'https://git.example.com'
      },
      fellBack: false
    })
  })

  it('uses upstream when the preference is upstream', async () => {
    mockRemotes({
      origin: 'https://git.example.com/me/fork.git',
      upstream: 'https://git.example.com/org/project.git'
    })

    await expect(resolveGiteaIssueSource('/fork', 'upstream')).resolves.toMatchObject({
      source: { owner: 'org', repo: 'project' },
      fellBack: false
    })
  })

  it('falls back to origin when upstream is requested but that remote is absent', async () => {
    mockRemotes({
      origin: 'https://git.example.com/org/project.git'
    })

    await expect(resolveGiteaIssueSource('/repo', 'upstream')).resolves.toMatchObject({
      source: { owner: 'org', repo: 'project' },
      fellBack: true
    })
  })

  it('prefers upstream for auto on a fork', async () => {
    mockRemotes({
      origin: 'https://git.example.com/me/fork.git',
      upstream: 'https://git.example.com/org/project.git'
    })

    await expect(resolveGiteaIssueSource('/fork', 'auto')).resolves.toMatchObject({
      source: { owner: 'org', repo: 'project' },
      fellBack: false
    })
  })

  it('uses origin for auto when the checkout is not a fork', async () => {
    mockRemotes({
      origin: 'https://git.example.com/org/project.git'
    })

    await expect(resolveGiteaIssueSource('/repo')).resolves.toMatchObject({
      source: { owner: 'org', repo: 'project' },
      fellBack: false
    })
  })

  it('uses a gitea remote when origin is not a Gitea repository', async () => {
    mockRemotes({
      origin: 'https://github.com/org/project.git',
      gitea: 'https://git.example.com/org/project.git'
    })

    await expect(resolveGiteaIssueSource('/repo', 'auto')).resolves.toMatchObject({
      source: { host: 'git.example.com', owner: 'org', repo: 'project' },
      fellBack: false
    })
  })
})
