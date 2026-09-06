import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillBundleInstallRequest } from '../../shared/skill-bundle-install-contract'
import type * as SkillBundleSshRelayService from '../skills/skill-bundle-ssh-relay-service'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'
import { toSshExecutionHostId } from '../../shared/execution-host'

const mocks = vi.hoisted(() => ({ installSkillBundleOnSshHost: vi.fn() }))

vi.mock('../skills/skill-bundle-ssh-relay-service', async (importOriginal) => ({
  ...(await importOriginal<typeof SkillBundleSshRelayService>()),
  installSkillBundleOnSshHost: mocks.installSkillBundleOnSshHost
}))

import { RuntimeSkillInstallCommands } from './runtime-skill-install-commands'

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
    getSshProvider: () => ({ requestHostRpc: vi.fn() }) as never,
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

describe('RuntimeSkillInstallCommands', () => {
  beforeEach(() => {
    mocks.installSkillBundleOnSshHost.mockReset()
  })

  it('retargets a global SSH bundle install to the owning host runtime', async () => {
    const request = createRequest()
    mocks.installSkillBundleOnSshHost.mockResolvedValue({
      operationId: request.operationId,
      packageId: request.package.packageId,
      versionId: request.package.versionId,
      bundleDigest: request.package.bundleDigest,
      status: 'complete',
      skills: []
    })

    await new RuntimeSkillInstallCommands(createHost()).installSharedSkillBundleRequest(request)

    expect(mocks.installSkillBundleOnSshHost).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          destination: { scope: 'global', executionTarget: { kind: 'host' } }
        })
      })
    )
    expect(request.destination).toEqual({
      scope: 'global',
      executionTarget: { kind: 'ssh', connectionId: 'ssh-1' }
    })
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
    expect(mocks.installSkillBundleOnSshHost).not.toHaveBeenCalled()
  })

  it('uses the exact SSH-owned worktree when ids collide in the resolved inventory', async () => {
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
    mocks.installSkillBundleOnSshHost.mockResolvedValue({
      operationId: request.operationId,
      packageId: request.package.packageId,
      versionId: request.package.versionId,
      bundleDigest: request.package.bundleDigest,
      status: 'complete',
      skills: []
    })

    await new RuntimeSkillInstallCommands(host).installSharedSkillBundleRequest(request)

    expect(mocks.installSkillBundleOnSshHost).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: {
          kind: 'worktree',
          id: request.destination.worktreeId,
          path: '/remote/app'
        }
      })
    )
  })
})
