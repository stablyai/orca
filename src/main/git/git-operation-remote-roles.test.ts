import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  getSshGitProviderGenerationMock,
  getSshGitProviderMock,
  readLocalGitConfigSignatureMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderGenerationMock: vi.fn(() => 0),
  getSshGitProviderMock: vi.fn(),
  readLocalGitConfigSignatureMock: vi.fn(async () => 'config-sig')
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: getSshGitProviderGenerationMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.'
}))
vi.mock('../github/local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

import {
  _resetGitOperationRemoteRoleCache,
  resolveHeadRole,
  resolveIssueSourceRole
} from './git-operation-remote-roles'

import { getGitRemoteTopologySnapshot } from './git-remote-topology-snapshot'

async function resolveGitOperationRemoteRoles(
  args: Parameters<typeof getGitRemoteTopologySnapshot>[0] & {
    branchName: string
    eligibleRemotes: (names: readonly string[]) => Promise<readonly string[]>
    persistedExactRemoteName?: string
    providerAuthInventory?: string
  }
) {
  const snapshot = await getGitRemoteTopologySnapshot(args)
  const remotes = await args.eligibleRemotes(snapshot.remoteNames)
  return {
    head: resolveHeadRole(snapshot, args.branchName, remotes, args.persistedExactRemoteName),
    issueSource: resolveIssueSourceRole(remotes, args.persistedExactRemoteName)
  }
}

function localProbe(args: {
  remotes: string[]
  branch?: string
  localOid?: string
  matchingRemotes?: string[]
  config?: Record<string, string>
}): void {
  const branch = args.branch ?? 'feature'
  const oid = args.localOid ?? 'head-oid'
  gitExecFileAsyncMock.mockImplementation(async (command: string[]) => {
    if (command[0] === 'remote') {
      return {
        stdout: args.remotes
          .flatMap((remote) => [
            `${remote}\thttps://github.com/${remote}/repo.git (fetch)`,
            `${remote}\thttps://github.com/${remote}/repo.git (push)`
          ])
          .join('\n')
      }
    }
    if (command[0] === 'config') {
      return {
        stdout: Object.entries(args.config ?? {})
          .map(([key, value]) => `${key}\n${value}\0`)
          .join('')
      }
    }
    const remoteRefs = (args.matchingRemotes ?? []).map(
      (remote) => `refs/remotes/${remote}/${branch}\0${oid}`
    )
    return {
      stdout: [`refs/heads/${branch}\0${oid}`, ...remoteRefs].join('\n')
    }
  })
}

async function resolve(remotes: string[], branchName = 'feature') {
  return resolveGitOperationRemoteRoles({
    repoPath: '/repo',
    branchName,
    providerAuthInventory: remotes.join(','),
    eligibleRemotes: async (names) => names.filter((name) => remotes.includes(name))
  })
}

describe('git operation remote roles', () => {
  beforeEach(() => {
    _resetGitOperationRemoteRoleCache()
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    getSshGitProviderGenerationMock.mockReset().mockReturnValue(0)
    readLocalGitConfigSignatureMock.mockReset().mockResolvedValue('config-sig')
  })

  it.each(['fork', 'renamed-fork'])(
    'uses matching branch-tip evidence after remote rename: %s',
    async (remote) => {
      localProbe({ remotes: ['origin', remote], matchingRemotes: [remote] })

      await expect(resolve(['origin', remote])).resolves.toMatchObject({
        head: {
          kind: 'resolved',
          selector: { kind: 'named-remote', value: remote },
          provenance: 'matching-remote-branch'
        }
      })
    }
  )

  it('keeps two matching head remotes explicitly ambiguous', async () => {
    localProbe({
      remotes: ['fork-a', 'fork-b'],
      matchingRemotes: ['fork-a', 'fork-b']
    })

    await expect(resolve(['fork-a', 'fork-b'])).resolves.toMatchObject({
      head: {
        kind: 'ambiguous',
        remoteNames: ['fork-a', 'fork-b'],
        provenance: 'matching-remote-branch'
      }
    })
  })

  it('does not confuse a configured compare base with the review head', async () => {
    localProbe({
      remotes: ['origin', 'fork'],
      matchingRemotes: ['fork'],
      config: {
        'branch.feature.remote': 'origin',
        'branch.feature.merge': 'refs/heads/main',
        'branch.feature.base': 'origin/main'
      }
    })

    await expect(resolve(['origin', 'fork'])).resolves.toMatchObject({
      head: {
        kind: 'resolved',
        selector: { kind: 'named-remote', value: 'fork' },
        provenance: 'matching-remote-branch'
      }
    })
  })

  it('uses persisted exact identity to disambiguate otherwise plausible remotes', async () => {
    localProbe({ remotes: ['company', 'mirror'] })

    await expect(
      resolveGitOperationRemoteRoles({
        repoPath: '/repo',
        branchName: 'feature',
        providerAuthInventory: 'company,mirror',
        persistedExactRemoteName: 'company',
        eligibleRemotes: async (names) => names
      })
    ).resolves.toMatchObject({
      issueSource: {
        kind: 'resolved',
        selector: { kind: 'named-remote', value: 'company' },
        provenance: 'persisted-exact-remote'
      }
    })
  })

  it('resolves one nonstandard issue source and preserves multiple-source ambiguity', async () => {
    localProbe({ remotes: ['gitlab-only'] })
    await expect(resolve(['gitlab-only'])).resolves.toMatchObject({
      issueSource: {
        kind: 'resolved',
        selector: { kind: 'named-remote', value: 'gitlab-only' },
        provenance: 'sole-provider-remote'
      }
    })

    _resetGitOperationRemoteRoleCache()
    localProbe({ remotes: ['gitlab-a', 'gitlab-b'] })
    await expect(resolve(['gitlab-a', 'gitlab-b'])).resolves.toMatchObject({
      issueSource: { kind: 'ambiguous', remoteNames: ['gitlab-a', 'gitlab-b'] }
    })
  })

  it('coalesces the first concurrent probe and reuses its bounded signed snapshot', async () => {
    localProbe({ remotes: ['fork'], matchingRemotes: ['fork'] })

    await Promise.all([resolve(['fork']), resolve(['fork']), resolve(['fork'])])
    await resolve(['fork'])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('reprobes after the local Git config signature changes', async () => {
    localProbe({ remotes: ['fork'], matchingRemotes: ['fork'] })
    readLocalGitConfigSignatureMock
      .mockResolvedValueOnce('config-a')
      .mockResolvedValueOnce('config-a')
      .mockResolvedValueOnce('config-b')
      .mockResolvedValueOnce('config-b')
      .mockResolvedValueOnce('config-b')

    await resolve(['fork'])
    await resolve(['fork'])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(6)
  })

  it('reuses Git evidence independently of provider authentication inventory', async () => {
    localProbe({ remotes: ['fork'], matchingRemotes: ['fork'] })

    await resolveGitOperationRemoteRoles({
      repoPath: '/repo',
      branchName: 'feature',
      providerAuthInventory: 'auth-a',
      eligibleRemotes: async (names) => names
    })
    await resolveGitOperationRemoteRoles({
      repoPath: '/repo',
      branchName: 'feature',
      providerAuthInventory: 'auth-b',
      eligibleRemotes: async (names) => names
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('does not cache a transient failed snapshot', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('git timed out'))
    await expect(resolve(['fork'])).rejects.toThrow('git timed out')

    localProbe({ remotes: ['fork'], matchingRemotes: ['fork'] })
    await expect(resolve(['fork'])).resolves.toMatchObject({
      head: {
        kind: 'resolved',
        selector: { kind: 'named-remote', value: 'fork' }
      }
    })
  })

  it('isolates SSH topology across provider reconnect generations', async () => {
    const firstProvider = {
      exec: vi.fn(async (command: string[]) => {
        if (command[0] === 'remote') {
          return { stdout: 'old\thttps://github.com/a/r (fetch)' }
        }
        if (command[0] === 'config') {
          return { stdout: '' }
        }
        return {
          stdout: 'refs/heads/feature\0one\nrefs/remotes/old/feature\0one'
        }
      })
    }
    const secondProvider = {
      exec: vi.fn(async (command: string[]) => {
        if (command[0] === 'remote') {
          return { stdout: 'new\thttps://github.com/b/r (fetch)' }
        }
        if (command[0] === 'config') {
          return { stdout: '' }
        }
        return {
          stdout: 'refs/heads/feature\0two\nrefs/remotes/new/feature\0two'
        }
      })
    }
    getSshGitProviderMock.mockReturnValue(firstProvider)
    await expect(
      resolveGitOperationRemoteRoles({
        repoPath: '/remote/repo',
        branchName: 'feature',
        connectionId: 'ssh-1',
        eligibleRemotes: async (names) => names
      })
    ).resolves.toMatchObject({
      head: { selector: { kind: 'named-remote', value: 'old' } }
    })

    getSshGitProviderGenerationMock.mockReturnValue(1)
    getSshGitProviderMock.mockReturnValue(secondProvider)
    await expect(
      resolveGitOperationRemoteRoles({
        repoPath: '/remote/repo',
        branchName: 'feature',
        connectionId: 'ssh-1',
        eligibleRemotes: async (names) => names
      })
    ).resolves.toMatchObject({
      head: { selector: { kind: 'named-remote', value: 'new' } }
    })
  })
})
