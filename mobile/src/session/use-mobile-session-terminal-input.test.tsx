import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWorkerTerminalTakeoverReportsForTest } from '../terminal/worker-terminal-takeover-report'
import {
  createTerminalSendSequenceState,
  setHostOrdersTerminalSends,
  TERMINAL_SEND_WINDOW
} from '../terminal/terminal-send-sequence'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'

const HANDLE = 'term-1'
const WHEEL_UP = '\x1b[<64;10;5M'
const TAP = '\x1b[<0;10;5M\x1b[<0;10;5m'
/** The round trip of the satellite profile the latency matrix measured. */
const SLOW_ROUND_TRIP_MS = 700

type RecordedSend = {
  atMs: number
  text: string
  sequence: { stream: string; seq: number } | undefined
}

const ref = <T,>(current: T) => ({ current })
const renderers: ReactTestRenderer[] = []

/** The real hook against a host that answers every send after `roundTripMs`. */
function mountGestureInput(options: { hostOrdersSends: boolean; roundTripMs: number }) {
  const sends: RecordedSend[] = []
  let outstanding = 0
  let peakOutstanding = 0
  let failNext = false
  const client = {
    sendRequest: vi.fn((method: string, params: unknown) => {
      if (method !== 'terminal.send') {
        return Promise.resolve({ id: 'rpc', ok: true as const, result: { changed: 1 } })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook builds these params with buildTerminalSendParams.
      const sent = params as { text: string; sequence?: RecordedSend['sequence'] }
      sends.push({ atMs: Date.now(), text: sent.text, sequence: sent.sequence })
      outstanding += 1
      peakOutstanding = Math.max(peakOutstanding, outstanding)
      const fails = failNext
      failNext = false
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          outstanding -= 1
          if (fails) {
            reject(new Error('timeout'))
          } else {
            resolve({ id: 'rpc', ok: true as const, result: { send: { accepted: true } } })
          }
        }, options.roundTripMs)
      })
    })
  }
  const terminalSendSequenceRef = ref(createTerminalSendSequenceState())
  setHostOrdersTerminalSends(terminalSendSequenceRef.current, options.hostOrdersSends)
  const scope = {
    client,
    clientRef: ref(client),
    connState: 'connected',
    connStateRef: ref('connected'),
    activeHandle: HANDLE,
    activeHandleRef: ref<string | null>(HANDLE),
    activeSessionTabTypeRef: ref<string | null>('terminal'),
    deviceTokenRef: ref('phone'),
    ptyModesRef: ref(new Map([[HANDLE, { altScreen: true, mouseTrackingMode: 'any' }]])),
    terminalGestureInputBucketsRef: ref(new Map()),
    terminalGestureInputQueuesRef: ref(new Map()),
    terminalGestureInputInFlightRef: ref(new Map()),
    terminalSendSequenceRef,
    liveInputRef: ref(null),
    liveInputFocusTimerRef: ref(null),
    terminalUnsubsRef: ref(new Map()),
    hostQueryReplyInputSupportedRef: ref(false),
    clearPendingLiveInputCommit: vi.fn(),
    toggleTerminalLiveInput: vi.fn(),
    getTerminalRef: vi.fn(),
    showToast: vi.fn()
  }
  let input!: ReturnType<typeof useMobileSessionTerminalInput>
  function Harness() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope above holds every member the hook reads on the paths these tests drive.
    input = useMobileSessionTerminalInput(scope as never)
    return null
  }
  act(() => {
    renderers.push(create(createElement(Harness)))
  })
  return {
    sends,
    peakOutstanding: () => peakOutstanding,
    failNextSend: () => {
      failNext = true
    },
    gesture: (bytes: string) => input.handleTerminalInput(HANDLE, bytes),
    /** A finger dragging: wheel reports every frame, one each unless it is a flick. */
    async drag(durationMs: number, reportsPerFrame = 1) {
      for (let elapsed = 0; elapsed < durationMs; elapsed += 16) {
        await input.handleTerminalInput(HANDLE, WHEEL_UP.repeat(reportsPerFrame))
        await vi.advanceTimersByTimeAsync(16)
      }
    }
  }
}

const clicks = (sends: RecordedSend[]) => sends.filter((send) => send.text.includes(TAP))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  resetWorkerTerminalTakeoverReportsForTest()
})
afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount()
    }
  })
  vi.useRealTimers()
})

describe('gesture input to a host that applies sends in order', () => {
  it('keeps sending during a drag on a slow link instead of one batch per round trip', async () => {
    const phone = mountGestureInput({ hostOrdersSends: true, roundTripMs: SLOW_ROUND_TRIP_MS })

    await phone.drag(1_500)
    expect(phone.sends.length).toBeGreaterThanOrEqual(10)
    expect(phone.peakOutstanding()).toBeLessThanOrEqual(TERMINAL_SEND_WINDOW)
  })

  it('spreads scroll sends across the round trip once a reply has measured it', async () => {
    const phone = mountGestureInput({ hostOrdersSends: true, roundTripMs: SLOW_ROUND_TRIP_MS })

    await phone.drag(2_100)

    const afterFirstReply = phone.sends.filter((send) => send.atMs - 10_000 > SLOW_ROUND_TRIP_MS)
    const gaps = afterFirstReply.slice(1).map((send, i) => send.atMs - afterFirstReply[i].atMs)
    // One window's worth of sends per round trip, a frame of timer slack either way.
    const spacing = SLOW_ROUND_TRIP_MS / TERMINAL_SEND_WINDOW
    expect(afterFirstReply.length).toBeGreaterThanOrEqual(10)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(spacing - 16)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(spacing + 16)
  })

  it('never sends more scroll reports at once than the cap, even after the window was full', async () => {
    const phone = mountGestureInput({ hostOrdersSends: true, roundTripMs: SLOW_ROUND_TRIP_MS })

    await phone.drag(2_100, 2)

    const reportsPerSend = phone.sends.map((send) => send.text.length / WHEEL_UP.length)
    expect(Math.max(...reportsPerSend)).toBeLessThanOrEqual(16)
  })

  it('numbers its sends consecutively in one stream, in the order they leave', async () => {
    const phone = mountGestureInput({ hostOrdersSends: true, roundTripMs: SLOW_ROUND_TRIP_MS })

    await phone.drag(200)

    expect(new Set(phone.sends.map((send) => send.sequence?.stream)).size).toBe(1)
    expect(phone.sends.map((send) => send.sequence?.seq)).toEqual(phone.sends.map((_, i) => i + 1))
  })

  it('sends a tap at once when the window is full of scroll sends, numbered after them', async () => {
    const phone = mountGestureInput({ hostOrdersSends: true, roundTripMs: SLOW_ROUND_TRIP_MS })
    await phone.drag(400)
    expect(phone.peakOutstanding()).toBe(TERMINAL_SEND_WINDOW)
    const tappedAtMs = Date.now()

    await phone.gesture(TAP)
    await vi.advanceTimersByTimeAsync(16)

    const [click] = clicks(phone.sends)
    expect(click.atMs - tappedAtMs).toBeLessThanOrEqual(16)
    expect(click.sequence?.seq).toBe(Math.max(...phone.sends.map((send) => send.sequence!.seq)))
  })

  it('sends a tap at once when scroll sends are being paced', async () => {
    const phone = mountGestureInput({ hostOrdersSends: true, roundTripMs: SLOW_ROUND_TRIP_MS })
    await phone.drag(SLOW_ROUND_TRIP_MS + 200)
    const sentBefore = phone.sends.length
    await phone.gesture(WHEEL_UP)
    const tappedAtMs = Date.now()

    await phone.gesture(TAP)

    expect(phone.sends).toHaveLength(sentBefore + 1)
    expect(clicks(phone.sends)[0].atMs).toBe(tappedAtMs)
  })

  it('starts a new stream after a send fails, so later input does not wait on its number', async () => {
    const phone = mountGestureInput({ hostOrdersSends: true, roundTripMs: 50 })
    phone.failNextSend()
    await phone.gesture(WHEEL_UP)
    await vi.advanceTimersByTimeAsync(100)

    await phone.gesture(WHEEL_UP)
    await vi.advanceTimersByTimeAsync(100)

    expect(phone.sends).toHaveLength(2)
    expect(phone.sends[1].sequence?.seq).toBe(1)
    expect(phone.sends[1].sequence?.stream).not.toBe(phone.sends[0].sequence?.stream)
  })
})

describe('gesture input to a host that does not advertise in-order application', () => {
  it('keeps one send outstanding and sends no sequence', async () => {
    const phone = mountGestureInput({ hostOrdersSends: false, roundTripMs: SLOW_ROUND_TRIP_MS })

    await phone.drag(1_500)
    await vi.advanceTimersByTimeAsync(SLOW_ROUND_TRIP_MS)
    expect(phone.peakOutstanding()).toBe(1)
    expect(phone.sends.every((send) => send.sequence === undefined)).toBe(true)
  })

  it('still delivers a tap after a drag when the reply it waited for took longer than 250 ms', async () => {
    const phone = mountGestureInput({ hostOrdersSends: false, roundTripMs: SLOW_ROUND_TRIP_MS })
    await phone.drag(300)

    await phone.gesture(TAP)
    await vi.advanceTimersByTimeAsync(SLOW_ROUND_TRIP_MS * 2)

    expect(clicks(phone.sends)).toHaveLength(1)
  })

  it('sends a short scroll after a slow reply instead of everything swiped meanwhile', async () => {
    const phone = mountGestureInput({ hostOrdersSends: false, roundTripMs: SLOW_ROUND_TRIP_MS })

    await phone.drag(SLOW_ROUND_TRIP_MS + 100, 2)

    const reportsPerSend = phone.sends.map((send) => send.text.length / WHEEL_UP.length)
    expect(reportsPerSend).toEqual([2, 16])
  })

  it('drops scroll reports that went stale waiting, so the screen stops when the finger did', async () => {
    const phone = mountGestureInput({ hostOrdersSends: false, roundTripMs: SLOW_ROUND_TRIP_MS })
    await phone.gesture(WHEEL_UP)
    await vi.advanceTimersByTimeAsync(16)
    await phone.gesture(WHEEL_UP.repeat(5))

    await vi.advanceTimersByTimeAsync(SLOW_ROUND_TRIP_MS * 2)

    expect(phone.sends.map((send) => send.text)).toEqual([WHEEL_UP])
  })
})
