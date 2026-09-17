import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_SEND_METHODS } from './terminal-send-method'
import { eraseRpcMethods, isStreamingMethod, type RpcMethod } from '../../core'

function makeRuntime(accepted: boolean) {
  const recordTerminalInputSource = vi.fn()
  const runtime = {
    resolveLiveLeafForHandle: vi.fn(() => ({ ptyId: 'pty-1' })),
    getDriver: vi.fn(() => ({ kind: 'desktop' })),
    isTerminalRunningSettledPromptAgent: vi.fn(async () => false),
    ensureStructuredAgentSessionHost: vi.fn(async () => null),
    sendTerminal: vi.fn(async () => ({ accepted, bytesWritten: accepted ? 3 : 0 })),
    recordTerminalInputSource
  }
  return { runtime, recordTerminalInputSource }
}

function sendMethod(): RpcMethod {
  const method = eraseRpcMethods(TERMINAL_SEND_METHODS).find(
    (m): m is RpcMethod => m.name === 'terminal.send' && !isStreamingMethod(m)
  )
  if (!method) {
    throw new Error('terminal.send is not registered')
  }
  return method
}

describe('terminal.send input source', () => {
  it('records the paired device from the RPC context once the write is accepted', async () => {
    const { runtime, recordTerminalInputSource } = makeRuntime(true)
    const method = sendMethod()

    await method.handler(method.params!.parse({ terminal: 'term-1', text: 'ls', enter: true }), {
      runtime,
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime'
    } as never)

    expect(recordTerminalInputSource).toHaveBeenCalledWith('pty-1', {
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime'
    })
  })

  it('records an in-process caller when the context carries no device', async () => {
    const { runtime, recordTerminalInputSource } = makeRuntime(true)
    const method = sendMethod()

    await method.handler(method.params!.parse({ terminal: 'term-1', text: 'ls' }), {
      runtime
    } as never)

    expect(recordTerminalInputSource).toHaveBeenCalledWith('pty-1', {
      pairedDeviceId: undefined,
      clientKind: undefined
    })
  })

  it('records nothing when the write is refused', async () => {
    const { runtime, recordTerminalInputSource } = makeRuntime(false)
    const method = sendMethod()

    await method.handler(method.params!.parse({ terminal: 'term-1', text: 'ls' }), {
      runtime,
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime'
    } as never)

    expect(recordTerminalInputSource).not.toHaveBeenCalled()
  })
})
