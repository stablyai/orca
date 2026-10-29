import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import { publishPtyEndpointLoss } from '../terminal/pty-endpoint-loss-signal'
import {
  WRITE_UNAVAILABLE_OPCODE,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

async function subscribe(capabilities: Record<string, 1>) {
  const harness = startDesktopMultiplexSubscribe()
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  sendDesktopMultiplexSubscribe(harness.handlers, capabilities)
  await vi.waitFor(() =>
    expect(
      harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
    ).toBe(true)
  )
  harness.binaryFrames.splice(0)
  return harness
}

const sawWriteUnavailable = (frames: Uint8Array[]): boolean =>
  frames.some((frame) => frame[2] === WRITE_UNAVAILABLE_OPCODE)

describe('terminal multiplex daemon endpoint loss notice', () => {
  it('tells a pane its daemon endpoint dropped before it types anything', async () => {
    const harness = await subscribe({ ackOutput: 1, writeUnavailable: 1, endpointLossNotice: 1 })

    publishPtyEndpointLoss('pty-1')

    // Push endpoint death immediately; waiting for the next refused keystroke leaves the pane frozen and loses input.
    expect(sawWriteUnavailable(harness.binaryFrames)).toBe(true)
  })

  it('ignores endpoint loss on other PTYs', async () => {
    const harness = await subscribe({ ackOutput: 1, writeUnavailable: 1, endpointLossNotice: 1 })

    publishPtyEndpointLoss('pty-other')

    expect(sawWriteUnavailable(harness.binaryFrames)).toBe(false)
  })

  it('keeps the unprompted frame from a client that reads it as refused input', async () => {
    const harness = await subscribe({ ackOutput: 1, writeUnavailable: 1 })

    publishPtyEndpointLoss('pty-1')

    expect(sawWriteUnavailable(harness.binaryFrames)).toBe(false)
  })

  it('stops notifying once the stream unsubscribes', async () => {
    const harness = await subscribe({ ackOutput: 1, writeUnavailable: 1, endpointLossNotice: 1 })
    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 7,
          seq: 1,
          payload: new Uint8Array()
        })
      )!
    )
    await vi.waitFor(() => expect(harness.handlers.has(7)).toBe(false))
    harness.binaryFrames.splice(0)

    publishPtyEndpointLoss('pty-1')

    expect(sawWriteUnavailable(harness.binaryFrames)).toBe(false)
  })
})
