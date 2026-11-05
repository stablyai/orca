import { describe, expect, it, vi } from 'vitest'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../shared/terminal/stream/terminal-stream-protocol'
import {
  BrowserNetworkTunnelOpcode,
  encodeBrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import { RuntimeBinaryMessageRouter } from './runtime-binary-message-router'

function tunnelPing(): Uint8Array {
  return encodeBrowserNetworkTunnelFrame({
    opcode: BrowserNetworkTunnelOpcode.Ping,
    tunnelGeneration: 1,
    streamId: 0,
    payload: new Uint8Array(8)
  })
}

function terminalOutput(streamId: number): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Output,
    streamId,
    seq: 1,
    payload: new Uint8Array([1, 2, 3])
  })
}

describe('RuntimeBinaryMessageRouter', () => {
  it('carries a phone browser tunnel beside terminal streams on one connection', () => {
    const router = new RuntimeBinaryMessageRouter()
    const terminalHandler = vi.fn()
    const tunnelHandler = vi.fn()

    router.registerTerminalStream('phone', 4, terminalHandler)
    const unregister = router.registerBrowserTunnel('phone', tunnelHandler)
    expect(() => router.registerBrowserTunnel('phone', vi.fn())).toThrow(
      'binary_handler_mode_conflict'
    )

    router.dispatch('phone', terminalOutput(4))
    router.dispatch('phone', tunnelPing())
    expect(terminalHandler).toHaveBeenCalledOnce()
    expect(tunnelHandler).toHaveBeenCalledOnce()

    unregister()
    router.dispatch('phone', tunnelPing())
    expect(tunnelHandler).toHaveBeenCalledOnce()
  })

  it('keeps a phone browser tunnel off raw-message connections', () => {
    const router = new RuntimeBinaryMessageRouter()
    router.registerRawMessage('desktop', vi.fn())
    expect(() => router.registerBrowserTunnel('desktop', vi.fn())).toThrow(
      'binary_handler_mode_conflict'
    )
    router.registerBrowserTunnel('phone', vi.fn())
    expect(() => router.registerRawMessage('phone', vi.fn())).toThrow(
      'binary_handler_mode_conflict'
    )
  })
})
