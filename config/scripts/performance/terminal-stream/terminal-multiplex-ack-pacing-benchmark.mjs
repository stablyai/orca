#!/usr/bin/env node
// Drive the real terminal multiplex over a modeled link: a TUI floods while the user types, and we report how long
// the echo takes to reach the client under legacy windows and opt-in adaptive pacing.
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)
const SRC = '../../../../src/'
const { RpcDispatcher } = await jiti.import(`${SRC}main/runtime/rpc/dispatcher.ts`)
const { TERMINAL_METHODS } = await jiti.import(
  `${SRC}main/runtime/rpc/methods/terminal/terminal.ts`
)
const { createSubscriptionRegistryDouble } = await jiti.import(
  `${SRC}main/runtime/rpc/subscription-registry-test-double.ts`
)
const {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} = await jiti.import(`${SRC}shared/terminal/stream/terminal-stream-protocol.ts`)

const STREAM_ID = 7
const STEP_MS = 10
const FLOOD_CHUNK = 64 * 1024

let clock = 0
Object.defineProperty(performance, 'now', { value: () => clock, configurable: true })
const tick = () => new Promise((resolve) => setImmediate(resolve))
const noop = () => {}

async function until(predicate) {
  for (let i = 0; i < 10_000 && !predicate(); i += 1) {
    await tick()
  }
}

async function run({
  mode,
  alternateScreen,
  bytesPerMs,
  ackReturnMs,
  jitterMs = 0,
  rttStep,
  floodEveryMs,
  echoAtMs,
  endMs
}) {
  process.env.ORCA_TERMINAL_ADAPTIVE_ACK_WINDOW = mode === 'legacy' ? '' : '1'
  clock = 0
  let seq = 0
  let screen = 'flood'
  let listener = null
  const messages = []
  const binaryFrames = []
  const handlers = new Map()
  const registry = createSubscriptionRegistryDouble()
  const runtime = {
    getRuntimeId: () => 'bench',
    getPtyExecutionHostMetadata: () => ({}),
    getTerminalLaunchResult: () => undefined,
    subscribeToPtyExit: () => noop,
    registerRemoteTerminalViewSubscriber: () => noop,
    isSoleRemoteTerminalQueryOwner: () => false,
    answerYieldedTerminalQueries: noop,
    resolveLiveLeafForHandle: () => ({ ptyId: 'pty-1' }),
    requestRendererTerminalTabMount: () => true,
    updateRemoteDesktopViewer: async () => true,
    unregisterRemoteDesktopViewer: async () => true,
    unregisterRemoteDesktopViewers: async () => true,
    isPtyResizeDrivenRemotely: () => false,
    getRemoteDesktopFitHold: () => ({ mode: 'desktop-fit', cols: 120, rows: 40 }),
    isRemoteDesktopViewerOwner: () => false,
    getPtyOutputSequence: () => 0,
    isTerminalAlternateScreen: () => alternateScreen,
    readTerminal: async () => ({ tail: [], truncated: false }),
    serializeTerminalBuffer: async () => ({
      data: `${'S'.repeat(8000)}${screen}`,
      cols: 120,
      rows: 40,
      seq,
      alternateScreen
    }),
    serializeAuthoritativeTerminalBuffer: async () => ({
      data: `${'S'.repeat(8000)}${screen}`,
      cols: 120,
      rows: 40,
      seq,
      alternateScreen
    }),
    getTerminalSize: () => ({ cols: 120, rows: 40 }),
    getMobileDisplayMode: () => 'auto',
    getLayout: () => ({ seq: 1 }),
    subscribeToTerminalData: (_ptyId, next) => {
      listener = next
      return noop
    },
    subscribeToTerminalResize: () => noop,
    subscribeToFitOverrideChanges: () => noop,
    subscribeToDriverChanges: () => noop,
    getTerminalFitOverride: () => null,
    getDriver: () => ({ kind: 'idle' }),
    waitForTerminal: () => new Promise(noop),
    ...registry
  }
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const done = dispatcher.dispatchStreaming(
    { id: 'req-1', authToken: 'tok', method: 'terminal.multiplex', params: {} },
    (msg) => messages.push(msg),
    {
      connectionId: 'bench',
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => handlers.delete(streamId)
      }
    }
  )
  const hasMessage = (type) => messages.some((msg) => JSON.parse(msg).result?.type === type)
  await until(() => hasMessage('ready'))
  handlers.get(0)(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: STREAM_ID,
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { ackOutput: 1 },
          viewport: { cols: 120, rows: 40 }
        })
      })
    )
  )
  await until(() => hasMessage('subscribed'))
  binaryFrames.splice(0)
  // A shell prompt before the TUI gives the link its base RTT.
  seq += 2
  listener('$ ', { seq, rawLength: 2 })
  await until(() => binaryFrames.length > 0)

  const wire = []
  const acks = []
  const decoder = new TextDecoder()
  let rng = 7
  let echoSeenAt = null
  let snapshots = 0
  let windowDelivered = 0
  for (clock = 0; clock < endMs && echoSeenAt === null; clock += STEP_MS) {
    if (clock % floodEveryMs === 0) {
      const echo = clock === echoAtMs
      // The typed key stays on screen, so any later snapshot shows it.
      screen = echo || screen === 'ECHO' ? 'ECHO' : 'flood'
      const data = (echo ? 'ECHO' : '') + 'x'.repeat(FLOOD_CHUNK - (echo ? 4 : 0))
      seq += data.length
      listener(data, { seq, rawLength: data.length })
    }
    for (const bytes of binaryFrames.splice(0)) {
      const frame = decodeTerminalStreamFrame(bytes)
      if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
        snapshots += 1
      }
      wire.push({
        remaining: bytes.byteLength,
        payloadBytes: frame.payload.byteLength,
        ackable: frame.opcode === TerminalStreamOpcode.Output,
        carriesEcho:
          echoAtMs !== undefined &&
          clock >= echoAtMs &&
          decoder.decode(frame.payload).includes('ECHO')
      })
    }
    let budget = bytesPerMs * STEP_MS
    while (budget > 0 && wire.length > 0) {
      const head = wire[0]
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
        if (
          rttStep &&
          clock >= rttStep.fromMs &&
          clock < rttStep.measureUntilMs &&
          clock >= rttStep.measureFromMs
        ) {
          windowDelivered += head.payloadBytes
        }
        rng = (rng * 1103515245 + 12345) % 2147483648
        const returnMs = rttStep && clock >= rttStep.fromMs ? rttStep.ackReturnMs : ackReturnMs
        acks.push({
          at: clock + returnMs + (jitterMs ? rng % jitterMs : 0),
          bytes: head.payloadBytes
        })
      }
    }
    acks.sort((a, b) => a.at - b.at)
    while (acks.length > 0 && acks[0].at <= clock) {
      const ack = acks.shift()
      handlers.get(STREAM_ID)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Ack,
            streamId: STREAM_ID,
            seq: 0,
            payload: encodeTerminalStreamJson({ bytes: ack.bytes })
          })
        )
      )
    }
    await tick()
  }
  registry.cleanupSubscription('terminal-multiplex:bench')
  await done
  return {
    echoMs: echoAtMs === undefined ? '-' : echoSeenAt === null ? 'never' : echoSeenAt - echoAtMs,
    snapshots,
    windowKBps: rttStep
      ? Math.round(windowDelivered / (rttStep.measureUntilMs - rttStep.measureFromMs))
      : '-'
  }
}

const SCENARIOS = [
  {
    name: '1 Mbit/s, 50ms',
    bytesPerMs: 125,
    ackReturnMs: 50,
    floodEveryMs: 100,
    echoAtMs: 40_000,
    endMs: 70_000
  },
  {
    // A full-screen truecolor repaint at 60fps outruns the link ~50x, so the queue overflows and recovers continuously.
    name: '1 Mbit/s, 50ms, 6.4 MB/s TUI',
    bytesPerMs: 125,
    ackReturnMs: 50,
    floodEveryMs: 10,
    echoAtMs: 40_000,
    endMs: 70_000
  },
  {
    name: '1 Mbit/s, 50-450ms jitter',
    bytesPerMs: 125,
    ackReturnMs: 50,
    jitterMs: 400,
    floodEveryMs: 100,
    echoAtMs: 40_000,
    endMs: 70_000
  },
  {
    name: 'LAN, 0.5 MB/s client',
    bytesPerMs: 500,
    ackReturnMs: 1,
    floodEveryMs: 100,
    echoAtMs: 5_000,
    endMs: 35_000
  },
  {
    name: '3 MB/s, RTT 50->500ms at 60s',
    bytesPerMs: 3_000,
    ackReturnMs: 50,
    floodEveryMs: 10,
    endMs: 90_000,
    rttStep: { fromMs: 60_000, ackReturnMs: 500, measureFromMs: 70_000, measureUntilMs: 90_000 }
  },
  {
    name: '1.5 MB/s, RTT 100->600ms at 60s',
    bytesPerMs: 1_500,
    ackReturnMs: 100,
    floodEveryMs: 20,
    endMs: 90_000,
    rttStep: { fromMs: 60_000, ackReturnMs: 600, measureFromMs: 70_000, measureUntilMs: 90_000 }
  }
]

for (const scenario of SCENARIOS) {
  for (const mode of ['legacy', 'paced']) {
    const result = await run({ ...scenario, mode, alternateScreen: true })
    console.log(
      `${scenario.name.padEnd(30)} ${mode.padEnd(10)} echo=${String(result.echoMs).padStart(6)}ms ` +
        `snapshots=${String(result.snapshots).padStart(3)} throughput=${result.windowKBps}KB/s`
    )
  }
}
