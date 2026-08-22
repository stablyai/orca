import { describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  TERMINAL_READ_INCARNATION_FENCE_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'terminal.read', params }
}

describe('terminal read incarnation fence RPC', () => {
  it('passes the optional expected incarnation to the runtime', async () => {
    const readTerminal = vi.fn().mockResolvedValue({
      handle: 'term-1',
      incarnationId: 'inc-1',
      worktreeId: 'repo-1::/tmp/worktree',
      status: 'running',
      tail: [],
      truncated: false,
      nextCursor: null
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'term-1',
        expectedIncarnationId: 'inc-1',
        cursor: 12,
        limit: 50
      })
    )

    expect(response.ok).toBe(true)
    expect(readTerminal).toHaveBeenCalledWith('term-1', {
      expectedIncarnationId: 'inc-1',
      cursor: 12,
      limit: 50,
      screen: undefined
    })
  })

  it('keeps legacy requests valid when the optional fence is absent', async () => {
    const readTerminal = vi.fn().mockResolvedValue({
      handle: 'term-1',
      status: 'running',
      tail: [],
      truncated: false,
      nextCursor: null
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(makeRequest({ terminal: 'term-1' }))

    expect(response.ok).toBe(true)
    expect(readTerminal).toHaveBeenCalledWith('term-1', {
      expectedIncarnationId: undefined,
      cursor: undefined,
      limit: undefined,
      screen: undefined
    })
  })

  it('preserves terminal_handle_stale as the guarded-read failure code', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readTerminal: vi.fn().mockRejectedValue(new Error('terminal_handle_stale'))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ terminal: 'term-1', expectedIncarnationId: 'inc-old' })
    )

    expect(response.ok).toBe(false)
    if (response.ok) {
      throw new Error('expected guarded read rejection')
    }
    expect(response.error.code).toBe('terminal_handle_stale')
  })

  it('rejects an oversized expected incarnation before calling the runtime', async () => {
    const readTerminal = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ terminal: 'term-1', expectedIncarnationId: 'x'.repeat(129) })
    )

    expect(response.ok).toBe(false)
    expect(readTerminal).not.toHaveBeenCalled()
  })

  it('publishes the guarded-read capability', () => {
    expect(RUNTIME_CAPABILITIES).toContain(TERMINAL_READ_INCARNATION_FENCE_RUNTIME_CAPABILITY)
  })
})
