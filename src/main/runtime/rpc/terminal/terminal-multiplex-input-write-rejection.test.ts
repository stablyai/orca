import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import {
  WRITE_UNAVAILABLE_OPCODE,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './testing/terminal-multiplex-test-harness'

describe('terminal multiplex rejected input signalling', () => {
  it('does not report a late rejection to a replacement stream with the same id', async () => {
    let settleWrite: (result: {
      handle: string
      accepted: boolean
      bytesWritten: number
    }) => void = () => {}
    const hostWrite = new Promise<{ handle: string; accepted: boolean; bytesWritten: number }>(
      (resolve) => {
        settleWrite = resolve
      }
    )
    const sendTerminal = vi.fn(() => hostWrite)
    const harness = startDesktopMultiplexSubscribe({
      sendTerminal: sendTerminal as unknown as OrcaRuntimeService['sendTerminal']
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    const capabilities = { ackOutput: 1 as const, writeUnavailable: 1 as const }
    sendDesktopMultiplexSubscribe(harness.handlers, capabilities)
    await vi.waitFor(() => expect(harness.handlers.has(7)).toBe(true))
    harness.binaryFrames.splice(0)

    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 7,
          seq: 2,
          payload: encodeTerminalStreamText('old')
        })
      )!
    )
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledOnce())
    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 7,
          seq: 3,
          payload: new Uint8Array()
        })
      )!
    )
    sendDesktopMultiplexSubscribe(harness.handlers, capabilities)
    await vi.waitFor(() =>
      expect(
        harness.messages.filter((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toHaveLength(2)
    )
    harness.binaryFrames.splice(0)

    settleWrite({ handle: 'terminal-1', accepted: false, bytesWritten: 0 })
    await hostWrite
    await Promise.resolve()

    expect(harness.binaryFrames.some((frame) => frame[2] === WRITE_UNAVAILABLE_OPCODE)).toBe(false)
  })
})
