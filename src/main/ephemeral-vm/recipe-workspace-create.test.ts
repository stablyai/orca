import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import type { EphemeralVmCheckoutMode } from '../../shared/orca-yaml-hook-types'
import type { RecipeWorkspaceCreatePhase } from '../../shared/recipe-workspace-create-progress'
import {
  createProvisionedRecipeWorkspace,
  RecipeWorkspaceCreateError
} from './recipe-workspace-create'
import type { EphemeralVmProvisionIpcResult } from './environment-provision'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { mapRuntimeError } from '../runtime/rpc/errors'

const runtimeRecord = {
  id: 'vm',
  recipeId: 'sandbox',
  repoId: 'source',
  status: 'running' as const,
  cleanupStatus: 'not_started' as const,
  createdAt: 1,
  updatedAt: 1
}
const provisionedRoot: EphemeralVmProvisionIpcResult = {
  ok: true,
  connectionType: 'ssh',
  sshTargetId: 'runtime-ssh-vm',
  environmentId: 'env-vm',
  expectedRefHead: 'source-head',
  stderr: '',
  warnings: [],
  runtime: {
    ...runtimeRecord,
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
// A VM whose SSH host runs a managed Orca server, with an ordinary (orca-worktree) checkout.
const managedServer: EphemeralVmProvisionIpcResult = {
  ok: true,
  connectionType: 'ssh',
  sshTargetId: 'runtime-ssh-vm',
  environmentId: 'env-server',
  stderr: '',
  warnings: [{ id: 'note', message: 'Using a shared image.' }],
  runtime: {
    ...runtimeRecord,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/repo',
        target: { host: 'vm', label: 'VM', username: 'orca', port: 22 }
      }
    }
  }
}
const remoteCapabilities = [
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY
]
function okCall(
  _env: string,
  method: string,
  _params: unknown
): Promise<RuntimeRpcResponse<unknown>> {
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
  return Promise.resolve({ id: 'req', ok: true, result, _meta: { runtimeId: 'remote' } })
}
function makePorts(provisioned: EphemeralVmProvisionIpcResult = provisionedRoot) {
  return {
    provision: vi.fn(async (onPhase: (phase: RecipeWorkspaceCreatePhase) => void) => {
      onPhase('running-create')
      onPhase('connecting')
      return provisioned
    }),
    call: vi.fn(okCall),
    attach: vi.fn(),
    cleanup: vi.fn(
      async (): Promise<{ outcome: 'destroyed' | 'failed' | 'disabled'; error?: string }> => ({
        outcome: 'destroyed'
      })
    )
  }
}
let ports = makePorts()
function request(
  extra: Record<string, unknown> = {},
  checkoutMode: EphemeralVmCheckoutMode = 'provisioned-root'
) {
  return {
    params: WorktreeCreate.parse({
      repo: 'id:source',
      name: 'task',
      recipeId: 'sandbox',
      ...extra
    }),
    recipeId: 'sandbox',
    checkoutMode,
    ...(checkoutMode === 'provisioned-root' ? { branchName: 'user/task' } : {}),
    projectId: 'git:project'
  }
}
async function failure(promise: Promise<unknown>): Promise<RecipeWorkspaceCreateError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  if (!(error instanceof RecipeWorkspaceCreateError)) {
    throw new Error(`expected a RecipeWorkspaceCreateError, got ${String(error)}`)
  }
  return error
}
beforeEach(() => {
  ports = makePorts()
})

describe('provisioned-root recipe workspace creation', () => {
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
    expect(ports.call.mock.calls.map(([, method]) => method)).toEqual([
      'status.get',
      'projectHostSetup.setupExistingFolder',
      'worktree.adoptProvisionedRoot'
    ])
    expect(ports.call.mock.calls[2]?.[2]).toMatchObject({ comment: 'handoff' })
    expect(ports.attach).toHaveBeenCalledWith('vm', 'remote-repo::/checkout')
    expect(result).toMatchObject({
      recipe: {
        id: 'sandbox',
        runtimeId: 'vm',
        environmentId: 'env-vm',
        checkoutMode: 'provisioned-root'
      },
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
  it('keeps lineage and the caller terminal out of the payload sent to the environment', async () => {
    await createProvisionedRecipeWorkspace(
      request({
        linkedGitLabIssue: 42,
        parentWorkspace: 'id:local-parent',
        cliProvenanceRequest: { callerTerminalHandle: 'term-local' }
      }),
      ports
    )
    const adopt = ports.call.mock.calls.find(
      ([, method]) => method === 'worktree.adoptProvisionedRoot'
    )
    expect(adopt?.[2]).toMatchObject({ linkedGitLabIssue: 42, cliProvenanceRequest: {} })
    expect(adopt?.[2]).not.toHaveProperty('parentWorkspace')
  })
})

describe('orca-worktree recipe workspace creation', () => {
  it('creates an ordinary worktree on the environment server, with setup and sparse checkout allowed', async () => {
    ports = makePorts(managedServer)
    const result = await createProvisionedRecipeWorkspace(
      request(
        { setupDecision: 'run', sparseCheckout: { directories: ['src'] }, comment: 'c' },
        'orca-worktree'
      ),
      ports
    )
    expect(ports.call.mock.calls.map(([, method]) => method)).toEqual([
      'status.get',
      'projectHostSetup.setupExistingFolder',
      'worktree.create'
    ])
    expect(ports.call).toHaveBeenLastCalledWith(
      'env-server',
      'worktree.create',
      expect.objectContaining({
        repo: 'id:remote-repo',
        name: 'task',
        setupDecision: 'run',
        sparseCheckout: { directories: ['src'] },
        comment: 'c'
      })
    )
    expect(ports.call.mock.calls.at(-1)?.[2]).not.toHaveProperty('recipeId')
    expect(result).toMatchObject({
      recipe: { environmentId: 'env-server', checkoutMode: 'orca-worktree' },
      worktree: { hostId: 'runtime:env-server' },
      environmentWarnings: ['Using a shared image.']
    })
    expect(ports.attach).toHaveBeenCalledWith('vm', 'remote-repo::/checkout')
  })
  it('refuses an environment without an Orca server and destroys it', async () => {
    const sshOnly = { ...provisionedRoot, environmentId: undefined }
    ports = makePorts(sshOnly)
    const error = await failure(createProvisionedRecipeWorkspace(request(), ports))
    expect(error.message).toContain('only the desktop app')
    expect(ports.cleanup).toHaveBeenCalledWith('vm')
  })
})

describe('recipe create failures', () => {
  it('reaches RPC callers with its code and failure data intact', () => {
    const data = {
      phase: 'checking-host' as const,
      recipeId: 'sandbox',
      environment: 'destroyed' as const
    }
    const response = mapRuntimeError(
      'req',
      { runtimeId: 'host' },
      new RecipeWorkspaceCreateError('Boom.', data)
    )
    expect(response.error).toEqual({
      code: 'recipe_workspace_create_failed',
      message: 'Boom.',
      data
    })
  })
  it('reports the recipe failure code from the create step without a destroy', async () => {
    ports.provision.mockResolvedValueOnce({
      ok: false,
      error: 'The recipe create step did not finish within 2 minutes.',
      errorCode: 'recipeTimedOut',
      errorParams: { mode: 'create', timeout: '2 minutes' },
      stdout: '',
      stderr: ''
    })
    const error = await failure(createProvisionedRecipeWorkspace(request(), ports))
    expect(error.data).toEqual({
      phase: 'running-create',
      recipeId: 'sandbox',
      failureCode: 'recipeTimedOut',
      failureParams: { mode: 'create', timeout: '2 minutes' }
    })
    expect(ports.cleanup).not.toHaveBeenCalled()
  })
  it('says whether the VM survived when the connect step fails after create', async () => {
    ports.provision.mockResolvedValueOnce({
      ok: false,
      error: 'SSH connect refused',
      runtimeId: 'vm',
      environmentCleanup: 'failed',
      stdout: '',
      stderr: ''
    })
    const error = await failure(createProvisionedRecipeWorkspace(request(), ports))
    expect(error.message).toMatch(/SSH connect refused.*runtime vm\) may still be running/)
    expect(error.data).toMatchObject({ runtimeId: 'vm', environment: 'destroy-failed' })
    expect(ports.cleanup).not.toHaveBeenCalled()
  })
  it('names the failed step and confirms the destroy when the server lacks adoption support', async () => {
    ports.call.mockImplementation(async () => ({
      id: 'req',
      ok: true,
      result: { capabilities: [] },
      _meta: { runtimeId: 'old' }
    }))
    const phases: RecipeWorkspaceCreatePhase[] = []
    const error = await failure(
      createProvisionedRecipeWorkspace(
        { ...request(), onPhase: (phase) => phases.push(phase) },
        ports
      )
    )
    expect(error.message).toMatch(/Update Orca.*destroyed the new environment/)
    expect(error.data).toMatchObject({
      phase: 'checking-host',
      runtimeId: 'vm',
      environment: 'destroyed'
    })
    expect(phases).toEqual([
      'running-create',
      'connecting',
      'checking-host',
      'destroying-after-failure'
    ])
    expect(ports.attach).not.toHaveBeenCalled()
  })
  it('says the machine may still run when its destroy also fails', async () => {
    ports.call.mockImplementationOnce(async () => ({
      id: 'req',
      ok: false,
      error: { code: 'unreachable', message: 'Remote host unavailable' }
    }))
    ports.cleanup.mockResolvedValueOnce({ outcome: 'failed', error: 'Destroy exited with code 1.' })
    const error = await failure(createProvisionedRecipeWorkspace(request(), ports))
    expect(error.message).toMatch(
      /Remote host unavailable.*runtime vm\) may still be running.*Destroy exited with code 1/
    )
    expect(error.data).toMatchObject({ environment: 'destroy-failed', phase: 'checking-host' })
  })
  it('never claims a destroy for a recipe without a destroy step', async () => {
    ports.call.mockImplementationOnce(async () => {
      throw new Error('socket closed')
    })
    ports.cleanup.mockResolvedValueOnce({ outcome: 'disabled' })
    const error = await failure(createProvisionedRecipeWorkspace(request(), ports))
    expect(error.message).toMatch(/no destroy step.*runtime vm\) is still running/)
    expect(error.message).not.toContain('Orca destroyed')
    expect(error.data.environment).toBe('destroy-disabled')
  })
  it('treats a throwing destroy as a failed destroy, not a lost error', async () => {
    ports.call.mockImplementationOnce(async () => {
      throw new Error('socket closed')
    })
    ports.cleanup.mockRejectedValueOnce(new Error('Unknown ephemeral VM runtime: vm'))
    const error = await failure(createProvisionedRecipeWorkspace(request(), ports))
    expect(error.data).toMatchObject({
      environment: 'destroy-failed',
      destroyError: 'Unknown ephemeral VM runtime: vm'
    })
  })
  it('destroys the environment when the caller disconnects after provisioning', async () => {
    const controller = new AbortController()
    ports.provision.mockImplementationOnce(async () => {
      controller.abort()
      return provisionedRoot
    })
    const error = await failure(
      createProvisionedRecipeWorkspace({ ...request(), signal: controller.signal }, ports)
    )
    expect(ports.call).not.toHaveBeenCalled()
    expect(ports.cleanup).toHaveBeenCalledTimes(1)
    expect(error.data.environment).toBe('destroyed')
  })
  it('checks agent support on the created server before adopting an agent workspace', async () => {
    const error = await failure(
      createProvisionedRecipeWorkspace(request({ createdWithAgent: 'codex' }), ports)
    )
    expect(error.message).toContain('Update Orca')
    expect(ports.cleanup).toHaveBeenCalledWith('vm')
    expect(ports.attach).not.toHaveBeenCalled()
  })
})
