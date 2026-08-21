import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from './terminal'

function request(params: unknown): RpcRequest {
  return {
    id: 'focus-1',
    authToken: 'token',
    method: 'terminal.focus',
    params
  }
}

describe('terminal focus navigation authority', () => {
  it('denies implicit paired focus while preserving local and explicit host focus', async () => {
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      focusTerminal: vi.fn().mockResolvedValue({
        handle: 'term-1',
        tabId: 'tab-1',
        worktreeId: 'wt-1'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(request({ terminal: 'term-1' }), () => {}, {
      clientKind: 'mobile',
      pairedDeviceId: 'device-a'
    })
    await dispatcher.dispatchStreaming(
      request({ terminal: 'term-1', navigation: 'host' }),
      () => {},
      { clientKind: 'runtime', pairedDeviceId: 'device-b' }
    )
    await dispatcher.dispatchStreaming(request({ terminal: 'term-1' }), () => {}, {
      clientKind: 'runtime',
      pairedDeviceId: 'device-b'
    })
    await dispatcher.dispatch(request({ terminal: 'term-1' }))

    expect(runtime.focusTerminal).toHaveBeenNthCalledWith(1, 'term-1', {
      navigateHost: false
    })
    expect(runtime.focusTerminal).toHaveBeenNthCalledWith(2, 'term-1', {
      navigateHost: true
    })
    expect(runtime.focusTerminal).toHaveBeenNthCalledWith(3, 'term-1', {
      navigateHost: false
    })
    expect(runtime.focusTerminal).toHaveBeenNthCalledWith(4, 'term-1', {
      navigateHost: true
    })
  })

  it('rejects client fanout targets that terminal focus cannot honor', async () => {
    const runtime = {
      getRuntimeId: () => 'runtime-1',
      focusTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      request({ terminal: 'term-1', navigation: 'clients' })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.focusTerminal).not.toHaveBeenCalled()
  })
})
