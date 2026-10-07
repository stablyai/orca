import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend
} from '../terminal/terminal-live-pending-flush-state'
import {
  createTerminalSendSequenceState,
  setHostOrdersTerminalSends,
  terminalSendWindow
} from '../terminal/terminal-send-sequence'
import { resetWorkerTerminalTakeoverReportsForTest } from '../terminal/worker-terminal-takeover-report'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn(), addListener: () => ({ remove: vi.fn() }) }
}))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))

const HANDLE = 'term-1'
/** The round trip of the satellite profile the latency matrix measured. */
const SLOW_ROUND_TRIP_MS = 700
const KEY_INTERVAL_MS = 120

type RecordedSend = {
  atMs: number
  text: string
  sequence: { stream: string; seq: number } | undefined
}

const ref = <T,>(current: T) => ({ current })
const renderers: ReactTestRenderer[] = []

/** The live field's typing queue and its real sender, against a host that answers after a slow round trip. */
function mountTyping(options: { hostOrdersSends: boolean }) {
  const sends: RecordedSend[] = []
  const client = {
    sendRequest: vi.fn((method: string, params: unknown) => {
      if (method === 'terminal.send') {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook builds these params with buildTerminalSendParams.
        const sent = params as Omit<RecordedSend, 'atMs'>
        sends.push({ atMs: Date.now(), text: sent.text, sequence: sent.sequence })
      }
      return new Promise((resolve) => {
        setTimeout(
          () => resolve({ id: 'rpc', ok: true as const, result: { send: { accepted: true } } }),
          SLOW_ROUND_TRIP_MS
        )
      })
    })
  }
  const terminalSendSequenceRef = ref(createTerminalSendSequenceState())
  setHostOrdersTerminalSends(terminalSendSequenceRef.current, options.hostOrdersSends)
  const scope = {
    client,
    clientRef: ref(client),
    activeHandle: HANDLE,
    activeHandleRef: ref<string | null>(HANDLE),
    activeSessionTabTypeRef: ref<string | null>('terminal'),
    activeSessionTab: { type: 'terminal', terminal: HANDLE },
    connStateRef: ref('connected'),
    deviceTokenRef: ref('phone'),
    liveInputRef: ref(null),
    commandInputRef: ref(null),
    liveInputFocusTimerRef: ref(null),
    sendLiveTerminalInputRef: ref(async () => false),
    terminalSendSequenceRef,
    sessionTabActionSheetKeyboardHideSubRef: ref(null),
    sessionTabActionSheetRequestSeqRef: ref(0),
    sendingRef: ref(false),
    canSend: true,
    getSendCompletionGeneration: () => 0,
    getLiveInteractionGeneration: () => 0,
    showToast: vi.fn(),
    bufferedTerminalDraftState: { input: '' }
  }
  let actions!: ReturnType<typeof useMobileSessionTerminalSendActions>
  function Harness() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope above holds every member the hook reads on the paths these tests drive.
    actions = useMobileSessionTerminalSendActions(scope as never)
    return null
  }
  act(() => {
    renderers.push(create(createElement(Harness)))
  })
  const queue = createTerminalLivePendingFlushState()
  return {
    sends,
    /** Types one key per interval and reports how long each waited in the app before its send left. */
    async type(keys: string): Promise<number[]> {
      const typedAtMs = new Map<string, number>()
      for (const key of keys) {
        typedAtMs.set(key, Date.now())
        void queueTerminalLiveMirrorSend(
          queue,
          HANDLE,
          key,
          actions.sendLiveTerminalInput,
          terminalSendWindow(terminalSendSequenceRef.current)
        )
        await vi.advanceTimersByTimeAsync(KEY_INTERVAL_MS)
      }
      await vi.advanceTimersByTimeAsync(SLOW_ROUND_TRIP_MS * 2)
      return [...typedAtMs].map(([key, atMs]) => {
        const send = sends.find((candidate) => candidate.text.includes(key))
        return send ? send.atMs - atMs : Number.POSITIVE_INFINITY
      })
    }
  }
}

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

describe('typing in the live field on a slow link', () => {
  it('sends each key as it is typed when the host applies sends in order', async () => {
    const phone = mountTyping({ hostOrdersSends: true })

    const waits = await phone.type('abcdef')

    expect(phone.sends.map((send) => send.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(waits).toEqual([0, 0, 0, 0, 0, 0])
    expect(new Set(phone.sends.map((send) => send.sequence?.stream)).size).toBe(1)
    expect(phone.sends.map((send) => send.sequence?.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(phone.sends[0].sequence?.stream.startsWith('keys-')).toBe(true)
  })

  it('holds keys for the reply in flight, unnumbered, when the host does not', async () => {
    const phone = mountTyping({ hostOrdersSends: false })

    const waits = await phone.type('abcdef')

    expect(phone.sends.map((send) => send.text)).toEqual(['a', 'bcdef'])
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(SLOW_ROUND_TRIP_MS - KEY_INTERVAL_MS)
    expect(phone.sends.every((send) => send.sequence === undefined)).toBe(true)
  })
})
