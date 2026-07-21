import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { TERMINAL_METHODS } from './terminal'

describe('terminal.create RPC idempotency', () => {
  it('scopes the mutation key to the authenticated paired device and worktree', async () => {
    const terminal = { handle: 'terminal-1', worktreeId: 'worktree-1', title: null }
    const createTerminal = vi.fn(async () => terminal)
    const dedupeTerminalCreate = vi.fn(
      async (
        _clientIdentity: string,
        _worktree: string | undefined,
        _mutationId: string | undefined,
        _reconcileExisting: boolean,
        run: (worktree: string | undefined, handle: string | undefined) => Promise<typeof terminal>
      ) => run('id:worktree-1', 'term_stable')
    )
    const method = TERMINAL_METHODS.find((candidate) => candidate.name === 'terminal.create')
    if (!method) {
      throw new Error('terminal.create method missing')
    }

    const result = await method.handler(
      {
        worktree: 'id:worktree-1',
        clientMutationId: 'mutation-1',
        command: 'pwsh',
        resumeProviderSession: {
          key: 'session_id',
          id: 'session-1',
          transcriptPath: 'C:\\Users\\example\\.codex\\sessions\\rollout.jsonl'
        }
      },
      {
        runtime: { createTerminal, dedupeTerminalCreate },
        pairedDeviceId: 'device-a',
        clientId: 'bearer-token'
      } as unknown as RpcContext,
      vi.fn()
    )

    expect(dedupeTerminalCreate).toHaveBeenCalledWith(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      false,
      expect.any(Function)
    )
    expect(createTerminal).toHaveBeenCalledWith(
      'id:worktree-1',
      expect.objectContaining({
        command: 'pwsh',
        preAllocatedHandle: 'term_stable',
        resumeProviderSession: {
          key: 'session_id',
          id: 'session-1',
          transcriptPath: 'C:\\Users\\example\\.codex\\sessions\\rollout.jsonl'
        }
      })
    )
    expect(result).toEqual({ terminal })
  })
})
