import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest, RpcContext } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import { WorktreeAgentLaunchPreCreateError } from '../../../agent-launch/agent-launch-worktree-resolution'

function worktreeCreateHandler(): (params: unknown, ctx: RpcContext) => Promise<unknown> {
  const method = WORKTREE_METHODS.find((m) => m.name === 'worktree.create')
  if (!method) {
    throw new Error('worktree.create method not registered')
  }
  return method.handler as (params: unknown, ctx: RpcContext) => Promise<unknown>
}

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git' as const,
  executionHostId: 'ssh:ssh-target-1' as const
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const agentLaunch = { selection: { kind: 'default' as const }, allowEmptyPromptLaunch: true }

const CUSTOM_ID = 'custom-agent:claude:11111111-1111-4111-8111-111111111111'

// No clientMutationId in these requests, so the real dedupe just runs the body.
const passThroughDedupe = <T>(
  _repo: string,
  _mutationId: string | undefined,
  run: () => Promise<T>
): Promise<T> => run()

describe('worktree.create pre-create agent-launch rejection', () => {
  it('returns a pre-create launch failure in-band as created:false, never a thrown RPC error', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passThroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockRejectedValue(
        new WorktreeAgentLaunchPreCreateError({
          failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
        })
      )
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', { repo: 'repo-1', name: 'agent-launch', agentLaunch })
    )

    // A pre-create rejection created no worktree, so it is an RPC SUCCESS with
    // `created: false` — a thrown error envelope would drop the typed recovery
    // hints the composer needs on every transport.
    expect(response).toMatchObject({
      ok: true,
      result: {
        created: false,
        agentLaunchResult: { status: 'failed', failure: { code: 'base_agent_disabled' } }
      }
    })
    const result = (response as { result: Record<string, unknown> }).result
    expect(result).not.toHaveProperty('worktree')
  })

  it('returns a pre-create request rejection in-band as created:false', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passThroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi
        .fn()
        .mockRejectedValue(
          new WorktreeAgentLaunchPreCreateError({ requestError: { code: 'untrusted_reference' } })
        )
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.create', { repo: 'repo-1', name: 'agent-launch', agentLaunch })
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        created: false,
        agentLaunchResult: { status: 'rejected', requestError: { code: 'untrusted_reference' } }
      }
    })
  })
})

describe('worktree.create legacy-path custom-id rejection (U7)', () => {
  const REJECTED = {
    created: false,
    agentLaunchResult: { status: 'rejected', requestError: { code: 'untrusted_reference' } }
  }

  it('rejects a remote client naming a custom startupAgent on the legacy path, before any runtime call', async () => {
    const showRepo = vi.fn()
    const createManagedWorktree = vi.fn()
    const runtime = {
      showRepo,
      createManagedWorktree,
      dedupeWorktreeCreate: passThroughDedupe
    } as unknown as RpcContext['runtime']

    const result = await worktreeCreateHandler()(
      { repo: 'repo-1', name: 'wt', startupAgent: CUSTOM_ID },
      { runtime, clientKind: 'mobile' }
    )

    // Rejected at the boundary, in-band as created:false — no worktree, no runtime work.
    expect(result).toEqual(REJECTED)
    expect(showRepo).not.toHaveBeenCalled()
    expect(createManagedWorktree).not.toHaveBeenCalled()
  })

  it('rejects a remote client naming a custom createdWithAgent on the legacy path', async () => {
    const showRepo = vi.fn()
    const runtime = {
      showRepo,
      dedupeWorktreeCreate: passThroughDedupe
    } as unknown as RpcContext['runtime']

    const result = await worktreeCreateHandler()(
      { repo: 'repo-1', name: 'wt', createdWithAgent: CUSTOM_ID },
      { runtime, clientKind: 'runtime' }
    )

    expect(result).toEqual(REJECTED)
    expect(showRepo).not.toHaveBeenCalled()
  })

  it('does NOT reject a trusted in-process caller (undefined clientKind) with a custom id — the guard is remote-scoped', async () => {
    // Prove the guard was skipped by letting the next runtime call (showRepo) throw a
    // sentinel and asserting it propagates — execution proceeded past the guard.
    const sentinel = new Error('proceeded-past-guard')
    const showRepo = vi.fn().mockRejectedValue(sentinel)
    const runtime = {
      showRepo,
      dedupeWorktreeCreate: passThroughDedupe
    } as unknown as RpcContext['runtime']

    await expect(
      worktreeCreateHandler()(
        { repo: 'repo-1', name: 'wt', startupAgent: CUSTOM_ID },
        { runtime, clientKind: undefined }
      )
    ).rejects.toBe(sentinel)
    expect(showRepo).toHaveBeenCalled()
  })
})
