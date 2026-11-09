import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import { WORKTREE_RECIPE_REMOVAL_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'
import { RuntimeClient } from './client'
import { removeOwnedRecipeWorkspace } from './owned-recipe-workspace-removal'

let root: string
const workspaceId = 'repo::/checkout'
const removal = {
  worktree: 'name:task',
  hostId: 'runtime:env-a',
  force: false,
  runHooks: false,
  allowFailedArchiveHook: false,
  allowUnverifiedPtyStop: false,
  waitForBackgroundRemoval: true
}
const requestSelection = { paramsForStatus: vi.fn(() => removal), onDispatch: vi.fn() }

function seed(mode: 'provisioned-root' | 'orca-worktree', cleanupDisabled = false): void {
  upsertEphemeralVmRuntime(root, {
    ...(cleanupDisabled ? { cleanupDisabled: true } : {}),
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
        projectRoot: '/checkout',
        target: { host: 'host', label: 'VM', port: 22, username: 'orca' }
      }
    }
  })
}

function localClient(capabilities: string[] = [WORKTREE_RECIPE_REMOVAL_RUNTIME_CAPABILITY]) {
  const client = new RuntimeClient(root, 1000, null, null)
  const call = vi
    .spyOn(client, 'call')
    .mockImplementation(async (method: string) =>
      method === 'status.get'
        ? { id: 's', ok: true, result: { capabilities }, _meta: { runtimeId: 'host' } }
        : { id: 'r', ok: true, result: { removed: true }, _meta: { runtimeId: 'host' } }
    )
  return { client, call }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-cli-recipe-remove-'))
  requestSelection.paramsForStatus.mockClear()
  requestSelection.onDispatch.mockClear()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('CLI removal of a recipe workspace', () => {
  it('leaves workspaces this computer did not provision on the ordinary path', async () => {
    const { client, call } = localClient()
    const result = await removeOwnedRecipeWorkspace(client, removal, requestSelection, {
      worktreeId: workspaceId,
      yes: true,
      json: true
    })
    expect(result).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses without --yes when nobody can answer a prompt, before anything is removed', async () => {
    seed('orca-worktree')
    const { client, call } = localClient()
    await expect(
      removeOwnedRecipeWorkspace(client, removal, requestSelection, {
        worktreeId: workspaceId,
        yes: false,
        json: true
      })
    ).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    expect(requestSelection.onDispatch).not.toHaveBeenCalled()
  })

  it('does not ask to destroy an environment whose recipe disables destroy', async () => {
    seed('orca-worktree', true)
    const { client, call } = localClient()
    await removeOwnedRecipeWorkspace(client, removal, requestSelection, {
      worktreeId: workspaceId,
      yes: false,
      json: true
    })
    expect(call).toHaveBeenLastCalledWith('worktree.rm', expect.anything(), expect.anything())
  })

  it('sends the resolved workspace id to the provisioning host, whatever selector was typed', async () => {
    seed('orca-worktree')
    const { client, call } = localClient()
    await removeOwnedRecipeWorkspace(client, removal, requestSelection, {
      worktreeId: workspaceId,
      yes: true,
      json: true
    })
    expect(call).toHaveBeenLastCalledWith(
      'worktree.rm',
      expect.objectContaining({
        worktree: `id:${workspaceId}`,
        hostId: 'runtime:env-a',
        force: false
      }),
      expect.objectContaining({ timeoutMs: 600_000 })
    )
    expect(requestSelection.onDispatch).toHaveBeenCalledTimes(1)
  })

  it('treats the confirmation as the force a provisioned root needs', async () => {
    seed('provisioned-root')
    const { client, call } = localClient()
    await removeOwnedRecipeWorkspace(client, removal, requestSelection, {
      worktreeId: workspaceId,
      yes: true,
      json: true
    })
    expect(call).toHaveBeenLastCalledWith(
      'worktree.rm',
      expect.objectContaining({ force: true }),
      expect.anything()
    )
  })

  it('refuses an older provisioning host instead of leaving the environment running', async () => {
    seed('orca-worktree')
    const { client, call } = localClient([])
    await expect(
      removeOwnedRecipeWorkspace(client, removal, requestSelection, {
        worktreeId: workspaceId,
        yes: true,
        json: true
      })
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
  })
})
