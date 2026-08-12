import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, sshExecMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  sshExecMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  glabExecFileAsync: vi.fn()
}))

import {
  _resetProjectRefCache,
  getIssueProjectRef,
  getProjectRef,
  orderRemoteNamesForProjectRefProbe,
  resolveIssueSource
} from './gl-utils'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

function mockGitRemotes(remotes: Record<string, string | null>): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: `${Object.keys(remotes).join('\n')}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const name = args[2] ?? ''
      if (!(name in remotes) || remotes[name] === null) {
        throw new Error(`error: No such remote '${name}'`)
      }
      return { stdout: `${remotes[name]}\n`, stderr: '' }
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  })
}

describe('gitlab nonstandard remote project ref resolution', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    sshExecMock.mockReset()
    unregisterSshGitProvider('conn-1')
    _resetProjectRefCache()
  })

  afterEach(() => {
    unregisterSshGitProvider('conn-1')
  })

  it('resolves a custom-named remote when origin and upstream are absent', async () => {
    mockGitRemotes({
      myremote: 'ssh://git@gitlab.example.com:2222/group/project.git'
    })

    await expect(getIssueProjectRef('/repo', ['gitlab.example.com'])).resolves.toEqual({
      host: 'gitlab.example.com',
      path: 'group/project'
    })
    await expect(getProjectRef('/repo', ['gitlab.example.com'])).resolves.toEqual({
      host: 'gitlab.example.com',
      path: 'group/project'
    })
  })

  it('skips a non-GitLab origin and still finds a custom GitLab remote', async () => {
    mockGitRemotes({
      origin: 'git@github.com:user/fork.git',
      myremote: 'git@gitlab.com:group/project.git'
    })

    await expect(getIssueProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'group/project'
    })
  })

  it('keeps upstream-then-origin preference over alphabetically earlier custom remotes', async () => {
    mockGitRemotes({
      aaa: 'git@gitlab.com:custom/aaa.git',
      origin: 'git@gitlab.com:fork/orca.git',
      upstream: 'git@gitlab.com:parent/orca.git'
    })

    await expect(getIssueProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'parent/orca'
    })
  })

  it('breaks ties among custom remotes deterministically by remote name', async () => {
    mockGitRemotes({
      zebra: 'git@gitlab.com:team/zebra.git',
      alpha: 'git@gitlab.com:team/alpha.git'
    })

    await expect(getIssueProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'team/alpha'
    })
    expect(orderRemoteNamesForProjectRefProbe(['zebra', 'alpha'])).toEqual(['alpha', 'zebra'])
  })

  it('resolves a custom remote through the SSH git provider', async () => {
    sshExecMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'myremote\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'myremote') {
        return { stdout: 'git@gitlab.com:remote/custom.git\n', stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2] ?? ''}'`)
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getIssueProjectRef('/repo', undefined, 'conn-1')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'remote/custom'
    })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps preferred-name negatives and custom-remote positives cached across polls', async () => {
    mockGitRemotes({
      myremote: 'git@gitlab.com:group/project.git'
    })

    await expect(getIssueProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'group/project'
    })
    const callsAfterFirst = gitExecFileAsyncMock.mock.calls.length

    await expect(getIssueProjectRef('/repo')).resolves.toEqual({
      host: 'gitlab.com',
      path: 'group/project'
    })
    // Preferred-name misses stay negatively cached; the custom remote stays positively cached.
    // Only a fresh `git remote` list is needed to know which custom names to try.
    expect(gitExecFileAsyncMock.mock.calls.length).toBe(callsAfterFirst + 1)
    expect(gitExecFileAsyncMock.mock.calls.at(-1)?.[0]).toEqual(['remote'])
  })

  it("'auto' resolves a custom remote name when origin/upstream are absent", async () => {
    mockGitRemotes({
      myremote: 'ssh://git@gitlab.example.com:2222/group/project.git'
    })

    await expect(resolveIssueSource('/repo', 'auto', ['gitlab.example.com'])).resolves.toEqual({
      source: { host: 'gitlab.example.com', path: 'group/project' },
      fellBack: false
    })
  })

  it("'origin' preference does not fall back to a custom remote name", async () => {
    mockGitRemotes({
      myremote: 'git@gitlab.com:group/project.git'
    })

    await expect(resolveIssueSource('/repo', 'origin')).resolves.toEqual({
      source: null,
      fellBack: false
    })
  })

  it("'upstream' + no upstream/origin falls back to a custom remote, fellBack=true", async () => {
    mockGitRemotes({
      myremote: 'git@gitlab.com:group/project.git'
    })

    await expect(resolveIssueSource('/repo', 'upstream')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'group/project' },
      fellBack: true
    })
  })
})
