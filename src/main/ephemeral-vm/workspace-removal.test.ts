import '../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { RecipeWorkspaceRemovalError } from '../../shared/recipe-host-removal'
import { mapRuntimeError } from '../runtime/rpc/responses/rpc-response'
import { removeRecipeWorkspace, type RecipeWorkspaceRemoveParams } from './workspace-removal'

let root: string
const workspaceId = 'repo::/workspace/repo-task'
const params: RecipeWorkspaceRemoveParams = {
  worktree: `id:${workspaceId}`,
  hostId: 'runtime:env-a',
  force: true,
  destroyHost: true
}

function ok(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'req', ok: true, result, _meta: { runtimeId: 'host' } }
}
function failed(code: string, message = code): RuntimeRpcResponse<unknown> {
  return { id: 'req', ok: false, error: { code, message, data: { detail: code } } }
}
const onlyMain = { worktrees: [{ id: 'repo::/workspace/repo', isMainWorktree: true }] }

function seed(
  mode: 'provisioned-root' | 'orca-worktree' = 'orca-worktree',
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): void {
  upsertEphemeralVmRuntime(root, {
    id: 'vm-a',
    recipeId: 'sandbox',
    repoId: 'source',
    workspaceId,
    workspaceName: 'task',
    runtimeEnvironmentId: 'env-a',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      ...(mode === 'provisioned-root'
        ? { schemaVersion: 2 as const, checkoutMode: mode }
        : { schemaVersion: 1 as const }),
      connection: {
        type: 'ssh',
        projectRoot: mode === 'provisioned-root' ? '/workspace/repo-task' : '/workspace/repo',
        target: { host: 'host', label: 'VM', port: 22, username: 'orca' }
      }
    },
    ...overrides
  })
}

function makePorts(
  answers: Partial<Record<string, RuntimeRpcResponse<unknown>>> = {},
  cleanupStatus: EphemeralVmRuntimeRecord['cleanupStatus'] = 'succeeded'
) {
  return {
    call: vi.fn(
      async (
        _env: string,
        method: string,
        _params?: unknown
      ): Promise<RuntimeRpcResponse<unknown>> =>
        answers[method] ?? (method === 'worktree.list' ? ok(onlyMain) : ok({ removed: true }))
    ),
    cleanup: vi.fn(async (runtimeId: string): Promise<EphemeralVmRuntimeRecord> => {
      const record = listEphemeralVmRuntimes(root).find((entry) => entry.id === runtimeId)
      if (!record) {
        throw new Error('missing record')
      }
      return { ...record, status: 'cleaned', cleanupStatus }
    })
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-recipe-remove-'))
})
afterEach(() => removeTempDirs([root]))

describe('recipe workspace removal on the provisioning host', () => {
  it('removes the checkout on the environment first, then destroys the empty environment', async () => {
    seed()
    const ports = makePorts()
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toEqual({
      removed: true,
      host: { runtimeId: 'vm-a', state: 'destroyed' }
    })
    const [, method, sent] = ports.call.mock.calls[0]
    expect(method).toBe('worktree.rm')
    expect(sent).toMatchObject({ hostId: 'local', waitForBackgroundRemoval: true })
    expect(sent).not.toHaveProperty('destroyHost')
    expect(ports.cleanup.mock.invocationCallOrder[0]).toBeGreaterThan(
      ports.call.mock.invocationCallOrder[1]
    )
  })

  it('keeps an environment that still holds other workspaces', async () => {
    seed()
    const ports = makePorts({
      'worktree.list': ok({
        worktrees: [...onlyMain.worktrees, { id: 'repo::/workspace/repo-other' }]
      })
    })
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toMatchObject({
      host: { state: 'kept' }
    })
    expect(ports.cleanup).not.toHaveBeenCalled()
  })

  it('keeps the environment when it cannot say whether it is empty', async () => {
    seed()
    const ports = makePorts({ 'worktree.list': failed('runtime_unavailable') })
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toMatchObject({
      host: { state: 'kept' }
    })
    expect(ports.cleanup).not.toHaveBeenCalled()
  })

  it('keeps the environment code and data when its removal fails, and destroys nothing', async () => {
    seed()
    const ports = makePorts({
      'worktree.rm': failed('worktree_archive_hook_failed', 'Hook failed')
    })
    const error = await removeRecipeWorkspace(root, params, ports).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(RecipeWorkspaceRemovalError)
    const response = mapRuntimeError('req', { runtimeId: 'host' }, error)
    expect(response.error).toEqual({
      code: 'worktree_archive_hook_failed',
      message: 'Hook failed',
      data: { detail: 'worktree_archive_hook_failed' }
    })
    expect(ports.cleanup).not.toHaveBeenCalled()
  })

  it('does not destroy while the checkout is still being removed', async () => {
    seed()
    const ports = makePorts({
      'worktree.rm': ok({ removed: false, removing: true }),
      'worktree.show': ok({ worktree: { id: workspaceId } })
    })
    await expect(
      removeRecipeWorkspace(root, params, ports, undefined, { attempts: 2, intervalMs: 0 })
    ).rejects.toThrow('still being removed')
    expect(ports.cleanup).not.toHaveBeenCalled()
  })

  it('finishes the destroy when the environment says the checkout is already gone', async () => {
    seed()
    const ports = makePorts({ 'worktree.rm': failed('selector_not_found') })
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toMatchObject({
      host: { state: 'destroyed' }
    })
  })

  it('says the machine may still run when its destroy fails', async () => {
    seed('provisioned-root')
    const ports = makePorts()
    ports.cleanup.mockResolvedValueOnce({
      ...listEphemeralVmRuntimes(root)[0],
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastError: 'Provider refused destroy'
    })
    const error = await removeRecipeWorkspace(root, params, ports).catch(
      (caught: unknown) => caught
    )
    expect(error).toMatchObject({
      code: 'recipe_host_destroy_failed',
      data: { runtimeId: 'vm-a' },
      message: expect.stringMatching(/Provider refused destroy.*may still be running/)
    })
  })

  it('waits for an older environment that answers on acceptance, then destroys', async () => {
    seed()
    const ports = makePorts({
      'worktree.rm': ok({ removed: false, removing: true }),
      'worktree.show': failed('selector_not_found')
    })
    await expect(
      removeRecipeWorkspace(root, params, ports, undefined, { attempts: 3, intervalMs: 0 })
    ).resolves.toMatchObject({ removed: true, host: { state: 'destroyed' } })
  })

  it('keeps the environment when its worktree list is truncated', async () => {
    seed()
    const ports = makePorts({ 'worktree.list': ok({ ...onlyMain, truncated: true }) })
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toMatchObject({
      host: { state: 'kept' }
    })
    expect(ports.cleanup).not.toHaveBeenCalled()
  })

  it('destroys an asleep provisioned root without waking it', async () => {
    seed('provisioned-root', { status: 'suspended' })
    const ports = makePorts()
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toMatchObject({
      host: { state: 'destroyed' }
    })
  })
})
