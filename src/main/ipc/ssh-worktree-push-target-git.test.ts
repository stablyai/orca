import { describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import {
  SshWorktreePushTargetRelayUnavailableError,
  type SshGitProvider
} from '../providers/ssh-git-provider'
import { cleanupUnusedWorktreePushTargetRemoteWithGit } from './worktree-push-target-cleanup'
import { cleanupUnusedRemoteWorktreePushTarget } from './worktree-remote'
import {
  configureCreatedWorktreePushTargetWithGit,
  prepareWorktreePushTargetWithGit
} from './worktree-push-target-setup'
import { createSshWorktreePushTargetGit } from './ssh-worktree-push-target-git'

const repoPath = '/remote/repo'
const target: GitPushTarget = {
  remoteName: 'pr-contributor-orca',
  branchName: 'contributor/fix',
  remoteUrl: 'git@github.com:contributor/orca.git'
}

function createProvider(remotes: Record<string, string>) {
  return {
    ensureWorktreePushTargetMutationSupport: vi.fn(async () => {}),
    exec: vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: Object.keys(remotes).join('\n'), stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        const url = remotes[args[2]!]
        if (!url) {
          throw new Error('missing remote')
        }
        return { stdout: `${url}\n`, stderr: '' }
      }
      if (args[0] === 'config') {
        return { stdout: '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }),
    addWorktreePushTargetRemote: vi.fn(async (_path, addedTarget) => {
      remotes[addedTarget.remoteName] = addedTarget.remoteUrl
    }),
    fetchRemoteTrackingRef: vi.fn(async () => {}),
    configureWorktreePushTarget: vi.fn(async () => {}),
    removeWorktreePushTargetRemote: vi.fn(async (_path, removedTarget) => {
      delete remotes[removedTarget.remoteName]
    })
  }
}

describe('SSH worktree push-target adapter', () => {
  it('rejects an invalid target before invoking the SSH provider', async () => {
    const provider = createProvider({})

    await expect(
      prepareWorktreePushTargetWithGit(
        createSshWorktreePushTargetGit(provider as unknown as SshGitProvider),
        repoPath,
        { ...target, remoteName: '../fork' },
        () => false
      )
    ).rejects.toThrow('Invalid git remote name')
    expect(provider.ensureWorktreePushTargetMutationSupport).not.toHaveBeenCalled()
    expect(provider.exec).not.toHaveBeenCalled()
  })

  it('allows a same-repo target on an old relay without probing mutation support', async () => {
    const provider = createProvider({ origin: 'git@github.com:stablyai/orca.git' })
    provider.ensureWorktreePushTargetMutationSupport.mockRejectedValueOnce(
      new SshWorktreePushTargetRelayUnavailableError('reconnect')
    )

    await expect(
      prepareWorktreePushTargetWithGit(
        createSshWorktreePushTargetGit(provider as unknown as SshGitProvider),
        repoPath,
        { remoteName: 'origin', branchName: 'feature' },
        () => false
      )
    ).resolves.toEqual({ remoteName: 'origin', branchName: 'feature' })
    expect(provider.ensureWorktreePushTargetMutationSupport).not.toHaveBeenCalled()
    expect(provider.exec).toHaveBeenCalledWith(
      ['check-ref-format', '--branch', 'feature'],
      repoPath
    )
    expect(provider.addWorktreePushTargetRemote).not.toHaveBeenCalled()
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      repoPath,
      'origin',
      'feature',
      'refs/remotes/origin/feature',
      { skipAutoMaintenance: true }
    )
  })

  it('rejects an old relay before adding a missing remote', async () => {
    const provider = createProvider({ origin: 'git@github.com:stablyai/orca.git' })
    provider.ensureWorktreePushTargetMutationSupport.mockRejectedValueOnce(
      new SshWorktreePushTargetRelayUnavailableError('reconnect')
    )

    await expect(
      prepareWorktreePushTargetWithGit(
        createSshWorktreePushTargetGit(provider as unknown as SshGitProvider),
        repoPath,
        target,
        () => false
      )
    ).rejects.toThrow('reconnect')
    expect(provider.ensureWorktreePushTargetMutationSupport).toHaveBeenCalledOnce()
    expect(provider.addWorktreePushTargetRemote).not.toHaveBeenCalled()
    expect(provider.fetchRemoteTrackingRef).not.toHaveBeenCalled()
  })

  it('creates a missing remote without sending remote add through exec', async () => {
    const provider = createProvider({ origin: 'git@github.com:stablyai/orca.git' })
    const prepared = await prepareWorktreePushTargetWithGit(
      createSshWorktreePushTargetGit(provider as unknown as SshGitProvider),
      repoPath,
      target,
      () => false
    )
    expect(provider.ensureWorktreePushTargetMutationSupport).toHaveBeenCalledOnce()
    expect(provider.addWorktreePushTargetRemote).toHaveBeenCalledWith(repoPath, target)
    expect(provider.exec).not.toHaveBeenCalledWith(
      ['remote', 'add', target.remoteName, target.remoteUrl],
      repoPath
    )
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      repoPath,
      target.remoteName,
      target.branchName,
      `refs/remotes/${target.remoteName}/${target.branchName}`,
      { skipAutoMaintenance: true }
    )
    expect(prepared.remoteCreated).toBe(true)
  })

  it('reuses an existing remote, fetches, and configures upstream', async () => {
    const provider = createProvider({ fork: 'https://github.com/contributor/orca.git' })
    const git = createSshWorktreePushTargetGit(provider as unknown as SshGitProvider)
    const prepared = await prepareWorktreePushTargetWithGit(git, repoPath, target, () => false)
    await configureCreatedWorktreePushTargetWithGit(git, '/remote/repo-fix', 'local-fix', prepared)
    expect(provider.ensureWorktreePushTargetMutationSupport).not.toHaveBeenCalled()
    expect(provider.addWorktreePushTargetRemote).not.toHaveBeenCalled()
    expect(prepared.remoteName).toBe('fork')
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      repoPath,
      'fork',
      target.branchName,
      `refs/remotes/fork/${target.branchName}`,
      { skipAutoMaintenance: true }
    )
    expect(provider.configureWorktreePushTarget).toHaveBeenCalledWith(
      '/remote/repo-fix',
      'local-fix',
      prepared
    )
  })

  it('uses the narrow removal method after shared cleanup checks', async () => {
    const provider = createProvider({ [target.remoteName]: target.remoteUrl! })
    await cleanupUnusedWorktreePushTargetRemoteWithGit(
      repoPath,
      'repo-1::/remote/repo-fix',
      { ...target, remoteCreated: true },
      {
        getAllWorktreeMeta: () => ({
          'repo-1::/remote/repo-fix': {
            pushTarget: { ...target, remoteCreated: true }
          } as WorktreeMeta
        })
      },
      createSshWorktreePushTargetGit(provider as unknown as SshGitProvider)
    )
    expect(provider.removeWorktreePushTargetRemote).toHaveBeenCalledWith(repoPath, {
      ...target,
      remoteCreated: true
    })
    expect(provider.exec).not.toHaveBeenCalledWith(
      ['remote', 'remove', target.remoteName],
      repoPath
    )
  })

  it('keeps deletion cleanup best-effort when the relay is stale', async () => {
    const provider = createProvider({ [target.remoteName]: target.remoteUrl! })
    provider.removeWorktreePushTargetRemote.mockRejectedValueOnce(
      new SshWorktreePushTargetRelayUnavailableError('reconnect')
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      cleanupUnusedRemoteWorktreePushTarget(
        provider as unknown as SshGitProvider,
        repoPath,
        'repo-1::/remote/repo-fix',
        { ...target, remoteCreated: true },
        {
          getAllWorktreeMeta: () => ({
            'repo-1::/remote/repo-fix': {
              pushTarget: { ...target, remoteCreated: true }
            } as WorktreeMeta
          })
        }
      )
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
