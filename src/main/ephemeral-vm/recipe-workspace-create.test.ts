import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { createProvisionedRecipeWorkspace } from './recipe-workspace-create'
import type { EphemeralVmProvisionIpcResult } from './environment-provision'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

const provisioned: EphemeralVmProvisionIpcResult = {
  ok: true,
  connectionType: 'ssh',
  sshTargetId: 'runtime-ssh-vm',
  environmentId: 'env-vm',
  expectedRefHead: 'source-head',
  stderr: '',
  warnings: [],
  runtime: {
    id: 'vm',
    recipeId: 'sandbox',
    repoId: 'source',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh',
        projectRoot: '/checkout',
        target: { host: 'vm', label: 'VM', username: 'orca', port: 22 }
      }
    }
  }
}
const remoteCapabilities = [
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY
]
const ports = {
  provision: vi.fn(async () => provisioned),
  call: vi.fn(
    async (
      _env: string,
      method: string,
      _params: unknown
    ): Promise<RuntimeRpcResponse<unknown>> => {
      const result =
        method === 'status.get'
          ? { capabilities: remoteCapabilities }
          : method === 'projectHostSetup.setupExistingFolder'
            ? { result: { repo: { id: 'remote-repo', path: '/checkout' } } }
            : {
                worktree: {
                  id: 'remote-repo::/checkout',
                  repoId: 'remote-repo',
                  path: '/checkout',
                  branch: 'refs/heads/user/task',
                  instanceId: 'instance'
                }
              }
      return { id: 'req', ok: true, result, _meta: { runtimeId: 'remote' } }
    }
  ),
  attach: vi.fn(),
  cleanup: vi.fn(async () => {})
}
function request(extra: Record<string, unknown> = {}) {
  return {
    params: WorktreeCreate.parse({
      repo: 'id:source',
      name: 'task',
      recipeId: 'sandbox',
      ...extra
    }),
    branchName: 'user/task',
    projectId: 'git:project'
  }
}
beforeEach(() => vi.clearAllMocks())

describe('CLI provisioned-root recipe workspace creation', () => {
  it('registers and adopts the pinned root on its server, then attaches the owner record', async () => {
    const result = await createProvisionedRecipeWorkspace(request({ comment: 'handoff' }), ports)
    expect(ports.call).toHaveBeenNthCalledWith(
      2,
      'env-vm',
      'projectHostSetup.setupExistingFolder',
      {
        projectId: 'git:project',
        hostId: 'local',
        path: '/checkout',
        kind: 'git',
        setupMethod: 'imported-existing-folder'
      }
    )
    expect(ports.call).toHaveBeenNthCalledWith(
      3,
      'env-vm',
      'worktree.adoptProvisionedRoot',
      expect.objectContaining({
        repo: 'id:remote-repo',
        branchNameOverride: 'user/task',
        expectedPath: '/checkout',
        expectedRefHead: 'source-head'
      })
    )
    expect(ports.call.mock.calls.some(([, method]) => method === 'worktree.create')).toBe(false)
    expect(ports.attach).toHaveBeenCalledWith('vm', 'remote-repo::/checkout')
    expect(result).toMatchObject({
      recipeEnvironmentId: 'env-vm',
      worktree: { hostId: 'runtime:env-vm' }
    })
    expect(ports.cleanup).not.toHaveBeenCalled()
  })
  it.each([
    { sparseCheckout: { directories: ['src'] } },
    { runHooks: true },
    { setupDecision: 'run' },
    { startupAgent: 'codex' },
    { name: '' }
  ])('refuses unsupported inputs before provisioning: %j', async (extra) => {
    await expect(createProvisionedRecipeWorkspace(request(extra), ports)).rejects.toThrow()
    expect(ports.provision).not.toHaveBeenCalled()
  })
  it('destroys the new machine when its Orca server lacks adoption support', async () => {
    const incompatible = {
      ...ports,
      call: vi.fn(async (): Promise<RuntimeRpcResponse<unknown>> => ({
        id: 'req',
        ok: true,
        result: { capabilities: [] },
        _meta: { runtimeId: 'old' }
      }))
    }
    await expect(createProvisionedRecipeWorkspace(request(), incompatible)).rejects.toThrow(
      'Update Orca'
    )
    expect(ports.cleanup).toHaveBeenCalledWith('vm')
    expect(ports.attach).not.toHaveBeenCalled()
  })
  it('destroys after adoption fails and preserves the original error when cleanup also fails', async () => {
    const failed = {
      ...ports,
      call: vi.fn(ports.call).mockImplementationOnce(async () => ({
        id: 'req',
        ok: false,
        error: { code: 'unreachable', message: 'Remote host unavailable' }
      })),
      cleanup: vi.fn(async () => {
        throw new Error('Destroy failed')
      })
    }
    await expect(createProvisionedRecipeWorkspace(request(), failed)).rejects.toThrow(
      'Remote host unavailable'
    )
    expect(failed.cleanup).toHaveBeenCalledWith('vm')
    expect(ports.attach).not.toHaveBeenCalled()
  })
  it('keeps provider references and CLI provenance in the adoption payload', async () => {
    await createProvisionedRecipeWorkspace(
      request({ linkedGitLabIssue: 42, cliProvenanceRequest: {} }),
      ports
    )
    expect(ports.call).toHaveBeenCalledWith(
      'env-vm',
      'worktree.adoptProvisionedRoot',
      expect.objectContaining({
        linkedGitLabIssue: 42,
        cliProvenanceRequest: {}
      })
    )
  })
  it('checks agent support on the created server before adopting an agent workspace', async () => {
    await expect(
      createProvisionedRecipeWorkspace(request({ createdWithAgent: 'codex' }), ports)
    ).rejects.toThrow('Update Orca')
    expect(ports.cleanup).toHaveBeenCalledWith('vm')
    expect(ports.attach).not.toHaveBeenCalled()
  })
})
