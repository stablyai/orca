import { describe, expect, it, vi } from 'vitest'
import type { SkillBundleInstallRequest } from '../../shared/skill-bundle-install-contract'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  RuntimeSkillInstallCommands,
  SKILL_SSH_UNAVAILABLE
} from './runtime-skill-install-commands'

function createHost(): RuntimeSkillCommandHost {
  return {
    getRuntimeId: () => 'runtime-1',
    getUserDataPath: () => '/tmp/orca-runtime-skill-test',
    isPackaged: () => true,
    getSettings: () => ({}),
    listRepos: () => [],
    listFolderWorkspaces: () => [],
    listResolvedWorktrees: async () => [],
    showManagedWorktree: async () => {
      throw new Error('unused')
    },
    skillTransactionRecovery: Promise.resolve()
  }
}

function createRequest(): SkillBundleInstallRequest {
  return {
    operationId: 'bundle-operation',
    package: {
      packageId: 'package-1',
      versionId: 'version-1',
      bundleDigest: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      compressedBytes: 100
    },
    selectedSkillIds: ['skill-1'],
    ingress: {
      kind: 'download-grant',
      url: 'https://storage.googleapis.com/test/bundle.tar.gz',
      expiresAt: '2026-08-29T12:00:00.000Z'
    },
    destination: {
      scope: 'global',
      executionTarget: { kind: 'ssh', connectionId: 'ssh-1' }
    },
    conflictDecisions: []
  }
}

// Why: this process serves no SSH target, so an SSH destination is refused before any local work.
describe('RuntimeSkillInstallCommands', () => {
  it('refuses a global SSH bundle install without touching this computer', async () => {
    const request = createRequest()
    const host = createHost()
    const showManagedWorktree = vi.fn(host.showManagedWorktree)
    host.showManagedWorktree = showManagedWorktree

    await expect(
      new RuntimeSkillInstallCommands(host).installSharedSkillBundleRequest(request)
    ).rejects.toThrow(SKILL_SSH_UNAVAILABLE)
    expect(showManagedWorktree).not.toHaveBeenCalled()
  })

  it('rejects an unqualified worktree id shared by local and SSH hosts', async () => {
    const request = {
      ...createRequest(),
      destination: { scope: 'workspace' as const, worktreeId: 'repo-1::/workspace/app' }
    }
    const host = createHost()
    host.listRepos = () => [
      { id: 'repo-1', path: '/workspace/app' },
      { id: 'repo-1', path: '/workspace/app', connectionId: 'ssh-1' }
    ]

    await expect(
      new RuntimeSkillInstallCommands(host).installSharedSkillBundleRequest(request)
    ).rejects.toThrow('skill-install-workspace-host-ambiguous')
  })

  it('places the exact SSH-owned worktree when ids collide, then refuses it', async () => {
    const request = {
      ...createRequest(),
      destination: { scope: 'workspace' as const, worktreeId: 'repo-1::/workspace/app' }
    }
    const host = createHost()
    host.listRepos = () => [{ id: 'repo-1', path: '/workspace/app', connectionId: 'ssh-1' }]
    host.listResolvedWorktrees = async () => [
      { id: request.destination.worktreeId, path: '/local/app', hostId: 'local' },
      {
        id: request.destination.worktreeId,
        path: '/remote/app',
        hostId: toSshExecutionHostId('ssh-1')
      }
    ]

    await expect(
      new RuntimeSkillInstallCommands(host).installSharedSkillBundleRequest(request)
    ).rejects.toThrow(SKILL_SSH_UNAVAILABLE)
  })
})
