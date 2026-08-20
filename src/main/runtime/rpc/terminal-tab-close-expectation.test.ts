import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

const expectation = {
  terminalHandle: 'term-a',
  ptyId: 'pty-a',
  leafId: 'leaf-a',
  incarnationId: 'inc-a'
}

describe('terminal.verifyTabCloseExpectation', () => {
  it('acknowledges only after the runtime verifies the exact incarnation', async () => {
    const verifyTerminalTabCloseExpectation = vi.fn()
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      verifyTerminalTabCloseExpectation
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'terminal.verifyTabCloseExpectation',
      params: expectation
    })

    expect(response).toMatchObject({ ok: true, result: { verified: true } })
    expect(verifyTerminalTabCloseExpectation).toHaveBeenCalledWith(expectation)
  })

  it('returns terminal_handle_stale without approving a replacement', async () => {
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      verifyTerminalTabCloseExpectation: vi.fn(() => {
        throw new Error('terminal_handle_stale')
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'terminal.verifyTabCloseExpectation',
      params: expectation
    })

    expect(response).toMatchObject({ ok: false, error: { message: 'terminal_handle_stale' } })
  })
})
