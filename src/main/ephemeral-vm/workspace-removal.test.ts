import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  upsertEphemeralVmRuntime,
  listEphemeralVmRuntimes
} from '../../shared/ephemeral-vm-runtime-store'
import {
  assertRecipeRemovalConfirmed,
  ownsRecipeWorkspaceRemoval,
  removeRecipeWorkspace,
  type RecipeWorkspaceRemoveParams
} from './workspace-removal'

let root: string
const workspaceId = 'repo::/checkout'
const params: RecipeWorkspaceRemoveParams = {
  worktree: `id:${workspaceId}`,
  hostId: 'runtime:env-a',
  force: true
}
const ports = {
  call: vi.fn(async () => ({
    id: 'req',
    ok: true as const,
    result: { removed: true },
    _meta: { runtimeId: 'host' }
  })),
  cleanup: vi.fn(async () => ({ status: 'cleaned' }))
}
function seed(
  mode: 'provisioned-root' | 'orca-worktree' = 'orca-worktree',
  environmentId = 'env-a',
  id = 'vm-a',
  attached = true,
  state: Partial<{ status: 'cleanup_failed' | 'suspended'; cleanupStatus: 'failed' }> = {}
) {
  upsertEphemeralVmRuntime(root, {
    id,
    recipeId: 'sandbox',
    repoId: 'source',
    ...(attached ? { workspaceId } : {}),
    runtimeEnvironmentId: environmentId,
    status: 'running',
    cleanupStatus: 'not_started',
    ...state,
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      ...(mode === 'provisioned-root'
        ? { schemaVersion: 2 as const, checkoutMode: mode }
        : { schemaVersion: 1 as const }),
      connection: {
        type: 'ssh',
        projectRoot: '/checkout',
        target: { host: 'host', label: 'VM', port: 22, username: 'orca' }
      }
    }
  })
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-recipe-remove-'))
  ports.call.mockClear()
  ports.cleanup.mockClear()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('recipe workspace removal on the provisioning host', () => {
  it('matches the host as well as the workspace and refuses ambiguous ownership', () => {
    seed()
    expect(ownsRecipeWorkspaceRemoval(root, params)).toBe(true)
    expect(ownsRecipeWorkspaceRemoval(root, { ...params, hostId: 'local' })).toBe(false)
    expect(ownsRecipeWorkspaceRemoval(root, { ...params, hostId: undefined })).toBe(false)
    seed('orca-worktree', 'env-b', 'vm-b')
    expect(ownsRecipeWorkspaceRemoval(root, params)).toBe(true)
    seed('orca-worktree', 'env-a', 'vm-c')
    expect(() => ownsRecipeWorkspaceRemoval(root, params)).toThrow('Multiple environment recipes')
  })
  it('removes the checkout on its execution host before destroying the machine', async () => {
    seed()
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toEqual({
      removed: true,
      environment: 'destroyed'
    })
    expect(ports.call).toHaveBeenCalledWith('env-a', 'worktree.rm', {
      ...params,
      hostId: 'local',
      waitForBackgroundRemoval: true
    })
    expect(ports.cleanup.mock.invocationCallOrder[0]).toBeGreaterThan(
      ports.call.mock.invocationCallOrder[0]
    )
  })
  it('matches legacy desktop roots by their exact path and host without a workspace attachment', async () => {
    seed('provisioned-root', 'env-a', 'vm-a', false)
    expect(listEphemeralVmRuntimes(root)[0].workspaceId).toBeUndefined()
    expect(ownsRecipeWorkspaceRemoval(root, params)).toBe(true)
    expect(
      ownsRecipeWorkspaceRemoval(root, { ...params, worktree: 'id:repo::/checkout/child' })
    ).toBe(false)
    expect(ownsRecipeWorkspaceRemoval(root, { ...params, hostId: 'runtime:env-b' })).toBe(false)
    await removeRecipeWorkspace(root, params, ports)
    expect(ports.cleanup).toHaveBeenCalledWith('vm-a')
    expect(ports.call).not.toHaveBeenCalled()
  })
  it('destroys an adopted root without attempting protected main-checkout deletion', async () => {
    seed('provisioned-root')
    await removeRecipeWorkspace(root, params, ports)
    expect(ports.call).not.toHaveBeenCalled()
    expect(ports.cleanup).toHaveBeenCalledWith('vm-a')
  })
  it('does not destroy a host whose Git removal failed or is still running', async () => {
    seed()
    const failed = {
      ...ports,
      call: vi.fn(async () => ({
        id: 'req',
        ok: false as const,
        error: { code: 'unreachable', message: 'Host unreachable' }
      }))
    }
    await expect(removeRecipeWorkspace(root, params, failed)).rejects.toThrow('Host unreachable')
    expect(ports.cleanup).not.toHaveBeenCalled()
    const pending = {
      ...ports,
      call: vi.fn(async () => ({
        id: 'req',
        ok: true as const,
        result: { removed: false, removing: true },
        _meta: { runtimeId: 'host' }
      }))
    }
    await expect(removeRecipeWorkspace(root, params, pending)).rejects.toThrow(
      'still being removed'
    )
    expect(ports.cleanup).not.toHaveBeenCalled()
  })
  it('retries only the destroy when a failed destroy already removed the checkout', async () => {
    seed('orca-worktree', 'env-a', 'vm-a', true, {
      status: 'cleanup_failed',
      cleanupStatus: 'failed'
    })
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toEqual({
      removed: true,
      environment: 'destroyed'
    })
    expect(ports.call).not.toHaveBeenCalled()
    expect(ports.cleanup).toHaveBeenCalledWith('vm-a')
  })
  it('keeps what the environment reported about the removed checkout', async () => {
    seed()
    const reported = {
      ...ports,
      call: vi.fn(async () => ({
        id: 'req',
        ok: true as const,
        result: { removed: true, preservedBranch: 'feature' },
        _meta: { runtimeId: 'host' }
      }))
    }
    await expect(removeRecipeWorkspace(root, params, reported)).resolves.toEqual({
      removed: true,
      preservedBranch: 'feature',
      environment: 'destroyed'
    })
  })
  it('finishes the destroy when the environment says the checkout is already gone', async () => {
    seed()
    const gone = {
      ...ports,
      call: vi.fn(async () => ({
        id: 'req',
        ok: false as const,
        error: { code: 'selector_not_found', message: 'Worktree not found' }
      }))
    }
    await expect(removeRecipeWorkspace(root, params, gone)).resolves.toMatchObject({
      removed: true
    })
    expect(ports.cleanup).toHaveBeenCalledWith('vm-a')
  })
  it('asks for a wake instead of failing on an asleep environment', async () => {
    seed('orca-worktree', 'env-a', 'vm-a', true, { status: 'suspended' })
    await expect(removeRecipeWorkspace(root, params, ports)).rejects.toThrow('asleep')
    expect(ports.call).not.toHaveBeenCalled()
    expect(ports.cleanup).not.toHaveBeenCalled()
  })
  it('leaves SSH-only recipe workspaces to the ordinary removal path', () => {
    upsertEphemeralVmRuntime(root, {
      id: 'vm-ssh',
      recipeId: 'sandbox',
      repoId: 'source',
      workspaceId,
      sshTargetId: 'target-1',
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        connection: {
          type: 'ssh',
          projectRoot: '/checkout',
          target: { host: 'host', label: 'VM', port: 22, username: 'orca' }
        }
      }
    })
    expect(ownsRecipeWorkspaceRemoval(root, { ...params, hostId: 'ssh:target-1' })).toBe(false)
  })
  it('refuses to destroy a provisioned-root VM unless removal is forced', () => {
    seed('provisioned-root')
    expect(() => assertRecipeRemovalConfirmed(root, { ...params, force: false })).toThrow(
      /vm-a.*--force/
    )
    expect(() => assertRecipeRemovalConfirmed(root, params)).not.toThrow()
  })
  it('surfaces destroy failure and keeps ownership available for a retry', async () => {
    seed('provisioned-root')
    const failed = {
      ...ports,
      cleanup: vi.fn(async () => ({
        status: 'cleanup_failed',
        cleanupLastError: 'Provider refused destroy'
      }))
    }
    await expect(removeRecipeWorkspace(root, params, failed)).rejects.toThrow(
      'Provider refused destroy'
    )
    expect(listEphemeralVmRuntimes(root)[0].workspaceId).toBe(workspaceId)
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toMatchObject({
      removed: true
    })
  })
  it('never destroys a same-id sibling on another host', async () => {
    seed()
    await expect(
      removeRecipeWorkspace(root, { ...params, hostId: 'runtime:env-b' }, ports)
    ).rejects.toThrow('ownership changed')
    expect(ports.call).not.toHaveBeenCalled()
    expect(ports.cleanup).not.toHaveBeenCalled()
  })
})
