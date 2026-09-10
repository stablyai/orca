import { expect, it, vi } from 'vitest'
import { settleOmpRpcTurnTerminal } from './omp-rpc-turn-response-settlement'
import type { OmpRpcPendingResponse } from './omp-rpc-command-correlation'

it('settles every acknowledged prompt when OMP emits one id-less terminal frame', () => {
  const first = vi.fn()
  const second = vi.fn()
  const pending = new Map<string, OmpRpcPendingResponse>([
    ['first', { command: 'prompt', resolve: first, reject: vi.fn(), hasAcknowledged: true }],
    ['second', { command: 'prompt', resolve: second, reject: vi.fn(), hasAcknowledged: true }]
  ])

  settleOmpRpcTurnTerminal(pending, { type: 'agent_end' })

  expect(first).toHaveBeenCalledWith(undefined)
  expect(second).toHaveBeenCalledWith(undefined)
  expect(pending.size).toBe(0)
})
