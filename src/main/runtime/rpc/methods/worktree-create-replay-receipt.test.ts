import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

const makeRequest = (params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'worktree.create',
  params
})

describe('worktree.create reservation replay receipt', () => {
  it('persists non-derivable response metadata before returning success', async () => {
    const recordReceipt = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: <T>(_repo: string, _id: string, run: () => Promise<T>) => run(),
      findManagedWorktreeReservation: vi.fn(() => ({ outcome: 'unbound' })),
      showRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'local'
      }),
      createManagedWorktree: vi.fn().mockResolvedValue({
        worktree: { id: 'wt-1', hostId: 'local' },
        warnings: [],
        startupTerminal: { spawned: true, handle: 'term_agent', surface: 'background' }
      }),
      recordWorktreeReservationCreateReceipt: recordReceipt
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        repo: 'repo-1',
        name: 'reserved-agent-startup',
        startupAgent: 'codex',
        reservation: {
          key: 'key-1',
          reservationId: 'res-1',
          sessionId: 'session-1',
          resourceKind: 'worktree',
          ownershipGeneration: 1
        }
      })
    )

    expect(recordReceipt).toHaveBeenCalledWith('wt-1', 'local', {
      version: 1,
      warnings: [],
      startupTerminal: { spawned: true, handle: 'term_agent', surface: 'background' },
      agentTerminalHandle: 'term_agent'
    })
    expect(response).toMatchObject({ ok: true, result: { agentTerminalHandle: 'term_agent' } })
  })
})
