import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  upsertEphemeralVmRuntime,
  listEphemeralVmRuntimes
} from '../../shared/ephemeral-vm-runtime-store'
import {
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
  attached = true
) {
  upsertEphemeralVmRuntime(root, {
    id,
    recipeId: 'sandbox',
    repoId: 'source',
    ...(attached ? { workspaceId } : {}),
    runtimeEnvironmentId: environmentId,
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
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toEqual({ removed: true })
    expect(ports.call).toHaveBeenCalledWith('env-a', 'worktree.rm', { ...params, hostId: 'local' })
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
        result: { removed: true, removing: true },
        _meta: { runtimeId: 'host' }
      }))
    }
    await expect(removeRecipeWorkspace(root, params, pending)).rejects.toThrow(
      'still being removed'
    )
    expect(ports.cleanup).not.toHaveBeenCalled()
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
    await expect(removeRecipeWorkspace(root, params, ports)).resolves.toEqual({ removed: true })
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
