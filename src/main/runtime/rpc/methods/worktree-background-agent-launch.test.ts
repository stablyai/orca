import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const CANONICAL_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('worktree.retryBackgroundAgentLaunch RPC', () => {
  it('rejects a non-canonical clientMutationId before dispatch', async () => {
    const retryBackgroundAgentLaunch = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      retryBackgroundAgentLaunch
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.retryBackgroundAgentLaunch', {
        attemptId: 'attempt-1',
        expectedFailureId: 'f1',
        clientMutationId: CANONICAL_UUID.toUpperCase(),
        action: { kind: 'retry-same' }
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(retryBackgroundAgentLaunch).not.toHaveBeenCalled()
  })

  it('passes a valid request through, keyed by attempt id, and returns its result', async () => {
    const receipt = {
      requestedAgent: 'claude' as const,
      baseAgent: 'claude' as const,
      notices: [],
      launchToken: 'tok',
      catalogRevision: 1
    }
    const retryBackgroundAgentLaunch = vi.fn().mockResolvedValue({ status: 'launched', receipt })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      retryBackgroundAgentLaunch
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.retryBackgroundAgentLaunch', {
        attemptId: 'attempt-1',
        expectedFailureId: 'f1',
        clientMutationId: CANONICAL_UUID,
        action: { kind: 'change-agent', agent: 'codex' }
      })
    )

    expect(response).toMatchObject({ ok: true, result: { status: 'launched' } })
    // clientKind and pairedDeviceId are both undefined for a local dispatch;
    // together they scope the idempotency principal, never client JSON.
    expect(retryBackgroundAgentLaunch).toHaveBeenCalledWith(
      {
        attemptId: 'attempt-1',
        expectedFailureId: 'f1',
        clientMutationId: CANONICAL_UUID,
        action: { kind: 'change-agent', agent: 'codex' }
      },
      undefined,
      undefined
    )
  })
})

describe('worktree.forgetBackgroundAgentLaunch RPC', () => {
  it('rejects a non-canonical clientMutationId before dispatch', async () => {
    const forgetBackgroundAgentLaunch = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      forgetBackgroundAgentLaunch
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.forgetBackgroundAgentLaunch', {
        attemptId: 'attempt-1',
        expectedOperationId: 'op-1',
        clientMutationId: CANONICAL_UUID.toUpperCase()
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(forgetBackgroundAgentLaunch).not.toHaveBeenCalled()
  })

  it('passes a valid forget request through and returns its result', async () => {
    const forgetBackgroundAgentLaunch = vi.fn().mockResolvedValue({ status: 'forgotten' })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      forgetBackgroundAgentLaunch
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.forgetBackgroundAgentLaunch', {
        attemptId: 'attempt-1',
        expectedOperationId: 'op-1',
        clientMutationId: CANONICAL_UUID
      })
    )

    expect(response).toMatchObject({ ok: true, result: { status: 'forgotten' } })
    expect(forgetBackgroundAgentLaunch).toHaveBeenCalledWith(
      {
        attemptId: 'attempt-1',
        expectedOperationId: 'op-1',
        clientMutationId: CANONICAL_UUID
      },
      undefined,
      undefined
    )
  })
})
