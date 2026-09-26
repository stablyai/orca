import { describe, expect, it, vi } from 'vitest'
import { TerminalStreamOpcode } from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import { installMultiplexFrameDelivery } from './terminal-multiplex-frame-delivery'
import type { RpcBinarySendResult } from '../../transports/rpc-binary-sender'

function frameDeliveryState(send: () => RpcBinarySendResult) {
  const closeConnection = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sendFrame reads only these fields.
  const state = {
    sendBinary: send,
    emit: vi.fn(),
    closed: false,
    cursor: 0,
    closeConnection
  } as unknown as TerminalMultiplexConnection
  state.closeMultiplex = () => {
    state.closed = true
  }
  installMultiplexFrameDelivery(state)
  return { state, closeConnection }
}

// Regression for #20802: a discarded frame closed only the multiplex, leaving the client's socket
// open with nothing behind it, so every later Input frame was dropped with no error.
describe('terminal multiplex discarded-frame close', () => {
  it('closes the whole connection once when the transport discards a frame', () => {
    const { state, closeConnection } = frameDeliveryState(() => false)

    expect(state.sendFrame(1, TerminalStreamOpcode.Output)).toBe(false)
    expect(state.sendFrame(1, TerminalStreamOpcode.Output)).toBe(false)

    expect(state.closed).toBe(true)
    expect(closeConnection).toHaveBeenCalledOnce()
    expect(closeConnection).toHaveBeenCalledWith(1013, expect.stringContaining('dropped'))
  })

  it('closes the connection when the transport throws', () => {
    const { state, closeConnection } = frameDeliveryState(() => {
      throw new Error('socket gone')
    })

    expect(state.sendFrame(1, TerminalStreamOpcode.Output)).toBe(false)
    expect(closeConnection).toHaveBeenCalledOnce()
  })

  it('leaves the connection alone while the transport accepts every frame', () => {
    const { state, closeConnection } = frameDeliveryState(() => true)

    expect(state.sendFrame(1, TerminalStreamOpcode.Output)).toBe(true)
    expect(state.closed).toBe(false)
    expect(closeConnection).not.toHaveBeenCalled()
  })
})
