import '../../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import { assertAgentLaunchTargetAuthorized } from '../agent-launch/agent-launch-target-authorization'
import { classifyRuntimeLongPoll } from '../../server/runtime-rpc-long-poll'

function makeRuntime() {
  const createManagedRecipeWorkspace = vi.fn(
    async (_params: unknown, options: { onPhase?: (phase: string) => void }) => {
      options.onPhase?.('running-create')
      return { recipe: { environmentId: 'vm-host' } }
    }
  )
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
  return { runtime, createManagedRecipeWorkspace, createManagedWorktree }
}

const recipeCreate = {
  id: 'req',
  authToken: 'token',
  method: 'worktree.create',
  params: { repo: 'id:source', name: 'task', recipeId: 'sandbox' }
}

it('reports named progress steps to a local caller', async () => {
  const { runtime } = makeRuntime()
  const reportProgress = vi.fn()
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  await dispatcher.dispatch(recipeCreate, { reportProgress })
  expect(reportProgress).toHaveBeenCalledWith({ phase: 'running-create' })
})

it('refuses a recipe create from a paired device before provisioning', async () => {
  const { runtime, createManagedRecipeWorkspace, createManagedWorktree } = makeRuntime()
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  const response = await dispatcher.dispatch(recipeCreate, { clientKind: 'mobile' })
  expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(createManagedRecipeWorkspace).not.toHaveBeenCalled()
  expect(createManagedWorktree).not.toHaveBeenCalled()
})

it('dispatches recipe creation through the host recipe service and deduplicates it', async () => {
  const createManagedRecipeWorkspace = vi
    .fn()
    .mockResolvedValue({ recipe: { environmentId: 'vm-host' } })
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
  expect(response).toMatchObject({ ok: true, result: { recipe: { environmentId: 'vm-host' } } })
  expect(dedupeWorktreeCreate).toHaveBeenCalledWith(
    expect.objectContaining({ repo: 'id:source' }),
    'create-1',
    expect.any(Function)
  )
  expect(createManagedRecipeWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({ recipeId: 'sandbox' }),
    expect.any(Object)
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
