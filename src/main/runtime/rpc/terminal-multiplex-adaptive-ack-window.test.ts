import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

const STREAM_ID = 7
const STEP_MS = 10
// The flooding TUI writes 640 KB/s.
const FLOOD_CHUNK = 64 * 1024
const FLOOD_EVERY_MS = 100
const ECHO_AT_MS = 40_000

// 1 Mbit/s with a 50 ms return path.
const SLOW_LINK = { bytesPerMs: 125, ackReturnMs: 50 }
// A LAN whose renderer parses only 500 KB/s.
const LAN_WITH_SLOW_CLIENT = { bytesPerMs: 500, ackReturnMs: 1 }

type InFlight = { remaining: number; payloadBytes: number; ackable: boolean; carriesEcho: boolean }

async function measureEchoLatencyMs(
  alternateScreen: boolean,
  link: { bytesPerMs: number; ackReturnMs: number } = SLOW_LINK
): Promise<number> {
  let clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  let seq = 0
  let screen = 'flood'
  const listener: { current?: (data: string, meta?: { seq: number; rawLength: number }) => void } =
    {}
  const { messages, binaryFrames, handlers, dispatchPromise, registry } =
    startDesktopMultiplexSubscribe({
      isTerminalAlternateScreen: () => alternateScreen,
      serializeTerminalBuffer: vi.fn(async () => ({
        data: `${'S'.repeat(8000)}${screen}`,
        cols: 120,
        rows: 40,
        seq,
        alternateScreen
      })),
      subscribeToTerminalData: vi.fn((_: string, next: typeof listener.current) => {
        listener.current = next
        return vi.fn()
      })
    })
  await vi.waitFor(() =>
    expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
  )
  sendDesktopMultiplexSubscribe(handlers)
  await vi.waitFor(() =>
    expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
  )
  binaryFrames.splice(0)

  // A shell prompt before the TUI gives the link its base RTT.
  seq += 2
  listener.current?.('$ ', { seq, rawLength: 2 })
  await vi.waitFor(() => expect(binaryFrames.length).toBeGreaterThan(0))
  const wire: InFlight[] = []
  const acks: { at: number; bytes: number }[] = []
  let echoSeenAt: number | null = null
  const decoder = new TextDecoder()
  for (clock = 0; clock < ECHO_AT_MS + 30_000 && echoSeenAt === null; clock += STEP_MS) {
    if (clock % FLOOD_EVERY_MS === 0) {
      const echo = clock === ECHO_AT_MS
      // The typed key stays on screen, so any later snapshot shows it.
      screen = echo || screen === 'ECHO' ? 'ECHO' : 'flood'
      const data = (echo ? 'ECHO' : '') + 'x'.repeat(FLOOD_CHUNK - (echo ? 4 : 0))
      seq += data.length
      listener.current?.(data, { seq, rawLength: data.length })
    }
    for (const bytes of binaryFrames.splice(0)) {
      const frame = decodeTerminalStreamFrame(bytes)!
      wire.push({
        remaining: bytes.byteLength,
        payloadBytes: frame.payload.byteLength,
        ackable: frame.opcode === TerminalStreamOpcode.Output,
        carriesEcho: clock >= ECHO_AT_MS && decoder.decode(frame.payload).includes('ECHO')
      })
    }
    let budget = link.bytesPerMs * STEP_MS
    while (budget > 0 && wire.length > 0) {
      const head = wire[0]!
      const sent = Math.min(budget, head.remaining)
      head.remaining -= sent
      budget -= sent
      if (head.remaining > 0) {
        break
      }
      wire.shift()
      if (head.carriesEcho) {
        echoSeenAt = clock
      }
      if (head.ackable) {
        acks.push({ at: clock + link.ackReturnMs, bytes: head.payloadBytes })
      }
    }
    while (acks.length > 0 && acks[0]!.at <= clock) {
      const ack = acks.shift()!
      handlers.get(STREAM_ID)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Ack,
            streamId: STREAM_ID,
            seq: 0,
            payload: encodeTerminalStreamJson({ bytes: ack.bytes })
          })
        )!
      )
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
  await dispatchPromise
  return (echoSeenAt ?? Number.POSITIVE_INFINITY) - ECHO_AT_MS
}

describe('terminal multiplex adaptive ACK window', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('keeps alternate-screen echo near the link delay while a TUI floods a slow link', async () => {
    vi.stubEnv('ORCA_TERMINAL_SUPERSEDE_ALT_BACKLOG', '1')
    expect(await measureEchoLatencyMs(true)).toBeLessThan(2_000)
  })

  it('leaves normal-screen output on the legacy window', async () => {
    const latency = await measureEchoLatencyMs(false)
    expect(latency).toBeGreaterThan(12_000)
    expect(latency).toBeLessThan(25_000)
  })

  it('never paces a low-RTT link, even when its client is slow', async () => {
    vi.stubEnv('ORCA_TERMINAL_SUPERSEDE_ALT_BACKLOG', '1')
    const paced = await measureEchoLatencyMs(true, LAN_WITH_SLOW_CLIENT)
    vi.stubEnv('ORCA_TERMINAL_ADAPTIVE_ACK_WINDOW', '0')
    expect(paced).toBe(await measureEchoLatencyMs(true, LAN_WITH_SLOW_CLIENT))
  })

  it('restores the legacy window when the kill switch is set', async () => {
    vi.stubEnv('ORCA_TERMINAL_SUPERSEDE_ALT_BACKLOG', '1')
    vi.stubEnv('ORCA_TERMINAL_ADAPTIVE_ACK_WINDOW', '0')
    const latency = await measureEchoLatencyMs(true)
    expect(latency).toBeGreaterThan(12_000)
    expect(latency).toBeLessThan(25_000)
  })
})
