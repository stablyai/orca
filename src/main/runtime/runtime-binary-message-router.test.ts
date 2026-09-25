import { describe, expect, it, vi } from 'vitest'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../shared/terminal-stream-protocol'
import { RuntimeBinaryMessageRouter } from './runtime-binary-message-router'

describe('RuntimeBinaryMessageRouter', () => {
  it('keeps terminal streams and raw browser messages on exclusive connections', () => {
    const router = new RuntimeBinaryMessageRouter()
    const terminalHandler = vi.fn()
    const rawHandler = vi.fn()

    router.registerTerminalStream('terminal-connection', 4, terminalHandler)
    expect(() => router.registerRawMessage('terminal-connection', rawHandler)).toThrow(
      'binary_handler_mode_conflict'
    )

    router.registerRawMessage('browser-connection', rawHandler)
    expect(() => router.registerTerminalStream('browser-connection', 4, terminalHandler)).toThrow(
      'binary_handler_mode_conflict'
    )

    router.dispatch(
      'terminal-connection',
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: 4,
        seq: 1,
        payload: new Uint8Array([1, 2, 3])
      })
    )
    router.dispatch('browser-connection', new Uint8Array([7, 8, 9]))

    expect(terminalHandler).toHaveBeenCalledOnce()
    expect(rawHandler).toHaveBeenCalledOnce()
  })
})
