import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalDataMeta } from '../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

type Harness = ReturnType<typeof startDesktopMultiplexSubscribe>

const GOLDEN_SUBSCRIBED =
  '{"type":"subscribed","streamId":7,"terminal":"terminal-1","cols":120,"rows":40,"displayMode":"auto","seq":1,"capabilities":{"outputPause":1},"truncated":false}'

function sendAck(harness: Harness, payload: unknown): void {
  harness.handlers.get(7)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Ack,
        streamId: 7,
        seq: 2,
        payload: encodeTerminalStreamJson(payload)
      })
    )!
  )
}

function hexFrames(harness: Harness): string[] {
  return harness.binaryFrames.map((bytes) => Buffer.from(bytes).toString('hex'))
}

// Older clients still offer ackOutputSourceRanges; this host never accepts it, so they fall back to byte ACKs.
async function runSession(capabilities: Record<string, 1>) {
  let dataListener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
  const harness = startDesktopMultiplexSubscribe({
    subscribeToTerminalData: vi.fn((_ptyId, listener) => {
      dataListener = listener
      return vi.fn()
    })
  })
  sendDesktopMultiplexSubscribe(harness.handlers, capabilities)
  await vi.waitFor(() =>
    expect(harness.messages.some((m) => JSON.parse(m).result?.type === 'subscribed')).toBe(true)
  )
  await vi.waitFor(() => expect(dataListener).toBeDefined())
  const flood = 'x'.repeat(700 * 1024)
  dataListener!(flood, { seq: flood.length, rawLength: flood.length })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const beforeAck = hexFrames(harness).length
  // A source-range ACK shape is not a byte ACK, so it must release no credit.
  sendAck(harness, { streamGeneration: 'generation', ackedEndByte: flood.length })
  const afterRangeAck = hexFrames(harness).length
  sendAck(harness, { bytes: flood.length })
  await new Promise((resolve) => setTimeout(resolve, 20))
  harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
  await harness.dispatchPromise
  return {
    messages: harness.messages.map((message) => JSON.stringify(JSON.parse(message).result)),
    frames: hexFrames(harness),
    beforeAck,
    afterRangeAck
  }
}

describe('terminal.multiplex subscribe offering ackOutputSourceRanges', () => {
  it('gets the byte-identical reply and frames of a byte-ACK subscribe', async () => {
    const offered = await runSession({ ackOutput: 1, ackOutputSourceRanges: 1, outputPause: 1 })
    const plain = await runSession({ ackOutput: 1, outputPause: 1 })

    expect(offered.messages).toContain(GOLDEN_SUBSCRIBED)
    expect(offered).toEqual(plain)
    expect(offered.afterRangeAck).toBe(offered.beforeAck)
    expect(offered.frames.length).toBeGreaterThan(offered.beforeAck)
  })
})
