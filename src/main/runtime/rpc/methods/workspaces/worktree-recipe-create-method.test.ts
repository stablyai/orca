import '../../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import { assertAgentLaunchTargetAuthorized } from '../agent-launch/agent-launch-target-authorization'
import { classifyRuntimeLongPoll } from '../../server/runtime-rpc-long-poll'

it('dispatches recipe creation through the host recipe service and deduplicates it', async () => {
  const createManagedRecipeWorkspace = vi.fn().mockResolvedValue({ recipeEnvironmentId: 'vm-host' })
  const createManagedWorktree = vi.fn()
  const dedupeWorktreeCreate = vi.fn(
    async (_repo: string, _mutation: string | undefined, run: () => Promise<unknown>) => run()
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this branch only reads the runtime id, deduplication and recipe creation ports supplied below.
  const runtime = {
    getRuntimeId: () => 'source-host',
    dedupeWorktreeCreate,
    createManagedRecipeWorkspace,
    createManagedWorktree
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  const response = await dispatcher.dispatch({
    id: 'req',
    authToken: 'token',
    method: 'worktree.create',
    params: {
      repo: 'id:source',
      name: 'task',
      recipeId: 'sandbox',
      clientMutationId: 'create-1'
    }
  })
  expect(response).toMatchObject({ ok: true, result: { recipeEnvironmentId: 'vm-host' } })
  expect(dedupeWorktreeCreate).toHaveBeenCalledWith('id:source', 'create-1', expect.any(Function))
  expect(createManagedRecipeWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({ recipeId: 'sandbox' })
  )
  expect(createManagedWorktree).not.toHaveBeenCalled()
})

it('refuses a recipe embedded in agent.launch before it can become an ordinary local create', () => {
  expect(() =>
    assertAgentLaunchTargetAuthorized(
      { kind: 'create-worktree', create: { recipeId: 'sandbox' } },
      {}
    )
  ).toThrow('Create the recipe workspace first')
})

it('keeps provisioning alive while preserving the ordinary create transport policy', () => {
  const request = { id: 'req', authToken: 'token', method: 'worktree.create' }
  expect(classifyRuntimeLongPoll({ ...request, params: { recipeId: 'sandbox' } })).toBe('wait')
  expect(classifyRuntimeLongPoll({ ...request, params: { repo: 'id:repo' } })).toBeNull()
})
