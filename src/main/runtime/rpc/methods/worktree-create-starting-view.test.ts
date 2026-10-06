import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

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

// worktree.create routes through the runtime's clientMutationId idempotency
// wrapper; these unit mocks run the create straight through (no dedupe).
const passthroughDedupe = <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
  run()

describe('worktree.create starting view', () => {
  it("forwards a paired client's startup view so the host stamps it (STA-6412)", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create method reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'agent-startup',
        startupCommand: 'claude',
        startupViewMode: 'chat'
      })
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ startupViewMode: 'chat', startup: { command: 'claude' } })
    )
  })
})
