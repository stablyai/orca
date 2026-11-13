import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import { TerminalMultiplexLinkEstimate } from '../methods/terminal/terminal-multiplex-link-estimate'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './testing/terminal-multiplex-test-harness'

const STREAM_ID = 7
const CHUNK = 64 * 1024

// A measured slow link: every read reports a 64KB paced window.
function measureSlowLink(): void {
  vi.spyOn(TerminalMultiplexLinkEstimate.prototype, 'steadyWindowBytes').mockReturnValue(CHUNK)
  vi.spyOn(TerminalMultiplexLinkEstimate.prototype, 'pacedWindowBytes').mockReturnValue(CHUNK)
}

async function openAltScreenStream() {
  const screen = { alternate: true }
  let seq = 0
  let listener: ((data: string, meta?: { seq: number; rawLength: number }) => void) | undefined
  const harness = startDesktopMultiplexSubscribe({
    isTerminalAlternateScreen: () => screen.alternate,
    serializeTerminalBuffer: vi.fn(async () => ({ data: 'screen', cols: 120, rows: 40, seq })),
    subscribeToTerminalData: vi.fn((_: string, next: typeof listener) => {
      listener = next
      return vi.fn()
    })
  })
  const hasMessage = (type: string) =>
    harness.messages.some((msg) => JSON.parse(msg).result?.type === type)
  await vi.waitFor(() => expect(hasMessage('ready')).toBe(true))
  sendDesktopMultiplexSubscribe(harness.handlers)
  await vi.waitFor(() => expect(hasMessage('subscribed')).toBe(true))
  harness.binaryFrames.splice(0)
  const frames = () =>
    harness.binaryFrames.splice(0).map((bytes) => decodeTerminalStreamFrame(bytes)!)
  return {
    screen,
    write(chunks: number) {
      for (let i = 0; i < chunks; i += 1) {
        seq += CHUNK
        listener?.('x'.repeat(CHUNK), { seq, rawLength: CHUNK })
      }
    },
    ack(bytes: number) {
      harness.handlers.get(STREAM_ID)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Ack,
            streamId: STREAM_ID,
            seq: 0,
            payload: encodeTerminalStreamJson({ bytes })
          })
        )!
      )
    },
    sentOutputBytes() {
      return frames()
        .filter((frame) => frame.opcode === TerminalStreamOpcode.Output)
        .reduce((total, frame) => total + frame.payload.byteLength, 0)
    },
    sentOpcodes() {
      return frames().map((frame) => frame.opcode)
    },
    async close() {
      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      await harness.dispatchPromise
    }
  }
}

describe('terminal multiplex adaptive ACK window', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('returns paced headroom once the queue drains, so later output overflows at the legacy cap', async () => {
    vi.stubEnv('ORCA_TERMINAL_ADAPTIVE_ACK_WINDOW', '1')
    measureSlowLink()
    const stream = await openAltScreenStream()
    // 64KB goes out; 448KB waits within the paced headroom instead of overflowing.
    stream.write(8)
    expect(stream.sentOutputBytes()).toBe(64 * 1024)
    for (let acked = 0; acked < 8; acked += 1) {
      stream.ack(CHUNK)
    }
    expect(stream.sentOutputBytes()).toBe(448 * 1024)
    stream.ack(CHUNK)
    // Unpaced again: 1MB fills the grown legacy window and 320KB queues past the 256KB cap.
    stream.screen.alternate = false
    stream.write(21)
    expect(stream.sentOutputBytes()).toBe(1024 * 1024)
    stream.ack(1)
    await vi.waitFor(() =>
      expect(stream.sentOpcodes()).toContain(TerminalStreamOpcode.SnapshotStart)
    )
    await stream.close()
  })
})
