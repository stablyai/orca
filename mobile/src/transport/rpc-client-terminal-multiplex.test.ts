import { describe, expect, it, vi } from 'vitest'
import { routeTerminalMultiplexFrame } from './rpc-client-terminal-multiplex'
import * as protocol from './terminal-stream-protocol'

const frameBytes = protocol.encodeTerminalStreamFrame({
  opcode: protocol.TerminalStreamOpcode.Output,
  streamId: 1,
  seq: 3,
  payload: new Uint8Array([1, 2, 3, 4])
})

describe('routeTerminalMultiplexFrame', () => {
  // Why: only the hosted shell subscribes terminal.multiplex, so a native client used to pay a
  // full payload copy per output frame before the router decoded the same bytes again.
  it('does not decode when no multiplex stream is registered', () => {
    const decode = vi.spyOn(protocol, 'decodeTerminalStreamFrame')

    const routed = routeTerminalMultiplexFrame(frameBytes, [
      { method: 'terminal.subscribe' },
      { method: 'session.tabs.subscribe' }
    ])

    expect(routed).toBe(false)
    expect(decode).not.toHaveBeenCalled()
    decode.mockRestore()
  })

  it('still routes to a live multiplex stream', () => {
    const decode = vi.spyOn(protocol, 'decodeTerminalStreamFrame')
    const onTerminalBinaryFrame = vi.fn(() => true)

    const routed = routeTerminalMultiplexFrame(frameBytes, [
      { method: 'terminal.subscribe' },
      { method: 'terminal.multiplex', onTerminalBinaryFrame }
    ])

    // Proves the spy in the previous case would have observed a decode had one happened.
    expect(decode).toHaveBeenCalledOnce()
    decode.mockRestore()
    expect(routed).toBe(true)
    expect(onTerminalBinaryFrame).toHaveBeenCalledWith(
      expect.objectContaining({ opcode: protocol.TerminalStreamOpcode.Output, streamId: 1, seq: 3 })
    )
  })

  it('skips a cancelled multiplex stream', () => {
    const onTerminalBinaryFrame = vi.fn(() => true)

    const routed = routeTerminalMultiplexFrame(frameBytes, [
      { method: 'terminal.multiplex', cancelled: true, onTerminalBinaryFrame }
    ])

    expect(routed).toBe(false)
    expect(onTerminalBinaryFrame).not.toHaveBeenCalled()
  })
})
