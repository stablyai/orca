import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const CANONICAL_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('worktree.retryAgentLaunch RPC', () => {
  it('validates the canonical lowercase UUID clientMutationId before dispatch', async () => {
    const retryWorktreeAgentLaunch = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      retryWorktreeAgentLaunch
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.retryAgentLaunch', {
        worktree: 'id:wt-1',
        expectedFailureId: 'f1',
        // Uppercase is not canonical lowercase form; rejected before any lookup.
        clientMutationId: CANONICAL_UUID.toUpperCase(),
        action: { kind: 'retry-same' }
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(retryWorktreeAgentLaunch).not.toHaveBeenCalled()
  })

  it('passes a valid request through to the runtime and returns its result', async () => {
    const receipt = {
      requestedAgent: 'claude' as const,
      baseAgent: 'claude' as const,
      notices: [],
      launchToken: 'tok',
      catalogRevision: 1
    }
    const retryWorktreeAgentLaunch = vi.fn().mockResolvedValue({ status: 'launched', receipt })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      retryWorktreeAgentLaunch
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.retryAgentLaunch', {
        worktree: 'id:wt-1',
        expectedFailureId: 'f1',
        clientMutationId: CANONICAL_UUID,
        action: { kind: 'change-agent', agent: 'codex' }
      })
    )

    expect(response).toMatchObject({ ok: true, result: { status: 'launched' } })
    // clientKind and pairedDeviceId are both undefined for an in-process/local
    // dispatch; together they scope the idempotency principal, never client JSON.
    expect(retryWorktreeAgentLaunch).toHaveBeenCalledWith(
      'id:wt-1',
      {
        expectedFailureId: 'f1',
        clientMutationId: CANONICAL_UUID,
        action: { kind: 'change-agent', agent: 'codex' }
      },
      undefined,
      undefined
    )
  })
})
