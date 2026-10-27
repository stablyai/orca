import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS } from './terminal-live-preedit-mirror'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

const composingRange = vi.hoisted(() => ({ hostReportsNone: false }))
vi.mock('../platform/live-input-composing-range', () => ({
  reportedLiveInputComposing: (isComposing: boolean | undefined) =>
    composingRange.hostReportsNone ? undefined : isComposing
}))

type TerminalLiveInputCommitHandlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

function changeLiveInput(
  handlers: TerminalLiveInputCommitHandlers,
  text: string,
  isComposing?: boolean
): void {
  handlers.handleLiveInputChange({ nativeEvent: { text, isComposing } })
}

type TerminalLiveInputCommitHarness = {
  readonly captures: readonly string[]
  readonly getHandlers: () => TerminalLiveInputCommitHandlers
  readonly handlers: TerminalLiveInputCommitHandlers
  readonly sent: readonly string[]
  readonly setActiveSessionTabType: (next: string | undefined) => void
  readonly setConnected: (next: boolean) => void
  readonly setSendResult: (next: boolean) => void
  readonly unmount: () => void
}

type TerminalLiveInputCommitHarnessOptions = {
  readonly sendResult?: boolean
}

function createTerminalLiveInputCommitHarness({
  sendResult = true
}: TerminalLiveInputCommitHarnessOptions = {}): TerminalLiveInputCommitHarness {
  const activeHandle = 'terminal-a'
  const activeHandleRef: RefObject<string | null> = { current: activeHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const captures: string[] = []
  const setLiveInputCapture = (text: string): void => {
    captures.push(text)
  }
  const liveInputRef: RefObject<TextInput | null> = { current: null }
  const liveInputTerminalHandles = new Set([activeHandle])
  const liveInputTerminalHandlesRef: RefObject<Set<string>> = {
    current: new Set([activeHandle])
  }
  const sent: string[] = []
  let currentSendResult = sendResult
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sent.push(bytes)
      return currentSendResult
    }
  }
  let currentActiveSessionTabType: string | undefined = 'terminal'
  let currentConnected = true
  let handlers: TerminalLiveInputCommitHandlers | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: currentActiveSessionTabType,
      activeSessionTabTypeRef,
      connected: currentConnected,
      liveInputRef,
      liveInputTerminalHandles,
      liveInputTerminalHandlesRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture
    })
    return null
  }

  act(() => {
    renderer = create(createElement(Harness))
  })
  if (!handlers || !renderer) {
    throw new Error('terminal live input hook did not render')
  }

  return {
    captures,
    getHandlers: () => {
      if (!handlers) {
        throw new Error('terminal live input hook is not mounted')
      }
      return handlers
    },
    handlers,
    sent,
    setActiveSessionTabType: (next: string | undefined): void => {
      currentActiveSessionTabType = next
      // Couple tab ref and prop as production does; both become null during inventory lag.
      activeSessionTabTypeRef.current = next ?? null
      act(() => {
        renderer?.update(createElement(Harness))
      })
    },
    setConnected: (next: boolean): void => {
      currentConnected = next
      act(() => {
        renderer?.update(createElement(Harness))
      })
    },
    setSendResult: (next: boolean): void => {
      currentSendResult = next
    },
    unmount: () => {
      act(() => renderer?.unmount())
    }
  }
}

describe('terminal live input commit hook', () => {
  afterEach(() => {
    vi.useRealTimers()
    composingRange.hostReportsNone = false
  })

  it('Given Hangul composition and no marked-text report When steps arrive Then no jamo leaks', async () => {
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    for (const fieldText of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
      changeLiveInput(handlers, fieldText)
      await vi.advanceTimersByTimeAsync(50)
    }

    await vi.waitFor(() => expect(sent).toEqual(['한글']))
  })

  it('Given Japanese romaji When the marked-text range is reported Then no reading reaches the terminal', async () => {
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    for (const fieldText of ['s', 'さ', 'さく', 'さくら']) {
      changeLiveInput(handlers, fieldText, true)
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS * 4)
    changeLiveInput(handlers, '桜', false)

    await vi.waitFor(() => expect(sent).toEqual(['桜']))
  })

  it('Given a reported preedit that goes idle When the settle delay passes Then nothing is committed on a timer', async () => {
    // Explicit preedit is not committed text and must never be promoted by an idle timer.
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    changeLiveInput(handlers, 'nihao', true)
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS * 10)

    expect(sent).toEqual([])
  })

  it('Given an Android WebView composing each word When letters follow a slash Then each reaches the terminal as typed', async () => {
    composingRange.hostReportsNone = true
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    changeLiveInput(handlers, '/', false)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    for (const fieldText of ['/t', '/tu', '/tui']) {
      changeLiveInput(handlers, fieldText, true)
      // Await each keystroke so batching cannot hide a held character.
      await vi.waitFor(() => expect(sent).toHaveLength(fieldText.length))
    }

    await vi.waitFor(() => expect(sent).toEqual(['/', 't', 'u', 'i']))
  })

  it('Given an Android WebView composing Hangul When steps arrive Then the non-ASCII run still settles on the timer', async () => {
    vi.useFakeTimers()
    composingRange.hostReportsNone = true
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    for (const fieldText of ['ㅎ', '하', '한']) {
      changeLiveInput(handlers, fieldText, true)
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)

    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given an iOS pinyin preedit When accessory Backspace edits it Then only the candidate reaches the terminal', async () => {
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, 'ni hao', true)

    await handlers.handleLiveInputAccessoryBytes({ bytes: '\x7f', localEdit: 'backspace' })
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS * 2)
    changeLiveInput(handlers, '你好', false)

    await vi.waitFor(() => expect(sent).toEqual(['你好']))
  })

  it('Given an Android heuristic hold When accessory Backspace edits it Then the remaining text still settles', async () => {
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한글')

    await handlers.handleLiveInputAccessoryBytes({ bytes: '\x7f', localEdit: 'backspace' })
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)

    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given a held syllable When an accessory Esc arrives Then commits the syllable before the Esc', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    await handlers.handleLiveInputAccessoryBytes({ bytes: '\x1b' })

    expect(sent).toEqual(['한', '\x1b'])
  })

  it('Given mirrored text When an accessory Enter arrives Then later typing starts a new line', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, 'ls')

    await handlers.handleLiveInputAccessoryBytes({ bytes: '\r' })
    changeLiveInput(handlers, 'x')

    await vi.waitFor(() => expect(sent).toEqual(['ls', '\r', 'x']))
  })

  it('Given a failed mirrored Backspace When accessory input commits Then reports failure', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })
    changeLiveInput(handlers, 'a', false)
    await vi.waitFor(() => expect(sent).toEqual(['a']))

    const result = await handlers.handleLiveInputAccessoryBytes({
      bytes: '\x7f',
      localEdit: 'backspace'
    })

    expect(sent).toEqual(['a', '\x7f'])
    expect(result).toEqual({ kind: 'suppress-raw' })
  })

  it('Given a held syllable When the settle timer elapses Then commits it to the terminal', async () => {
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)

    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given a timer-committed syllable When composition continues Then corrects with DEL and recommits', async () => {
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '하')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)
    await vi.waitFor(() => expect(sent).toEqual(['하']))

    changeLiveInput(handlers, '한')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)

    await vi.waitFor(() => expect(sent).toEqual(['하', '\x7f', '한']))
  })

  it('Given Hangul pending text When submit is requested Then sends composed text before carriage return', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    const accepted = await handlers.handleLiveInputSubmit()

    expect(accepted).toBe(true)
    await vi.waitFor(() => expect(sent).toEqual(['한', '\r']))
  })

  it('Given no pending text When submit is requested Then sends only carriage return', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    const accepted = await handlers.handleLiveInputSubmit()

    expect(accepted).toBe(true)
    await vi.waitFor(() => expect(sent).toEqual(['\r']))
  })

  it('increments a stable interaction generation for typing, submit, and accessory Enter', async () => {
    const { getHandlers, handlers, setActiveSessionTabType } =
      createTerminalLiveInputCommitHarness()
    const getter = handlers.getLiveInputInteractionGeneration
    const initialGeneration = getter()

    changeLiveInput(handlers, 'newer text')
    const typedGeneration = getter()
    await handlers.handleLiveInputSubmit()
    const submitGeneration = getter()
    await handlers.handleLiveInputAccessoryBytes({ bytes: '\r' })
    setActiveSessionTabType(undefined)

    expect(getHandlers().getLiveInputInteractionGeneration).toBe(getter)
    expect(typedGeneration).toBe(initialGeneration + 1)
    expect(submitGeneration).toBeGreaterThan(typedGeneration)
    expect(getter()).toBeGreaterThan(submitGeneration)
  })

  it('Given a rejected held-text send When submit is requested Then suppresses the carriage return', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })
    changeLiveInput(handlers, '한')

    const accepted = await handlers.handleLiveInputSubmit()

    expect(accepted).toBe(false)
    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given a rejected carriage return When submit is requested Then reports rejection', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })

    const accepted = await handlers.handleLiveInputSubmit()

    expect(accepted).toBe(false)
    expect(sent).toEqual(['\r'])
  })

  it('Given ASCII typing When changes arrive Then mirrors immediately', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    changeLiveInput(handlers, 'a')
    changeLiveInput(handlers, 'ab')

    await vi.waitFor(() => expect(sent).toEqual(['a', 'b']))
  })

  it('Given iOS smart-dash text When the change arrives Then the capture echoes the raw field text and the PTY gets normalized bytes', async () => {
    const { captures, handlers, sent } = createTerminalLiveInputCommitHarness()

    changeLiveInput(handlers, 'a–')

    // Echo native smart punctuation verbatim; controlled write-back would kill active iOS dictation/IME.
    expect(captures).toEqual(['a–'])
    await vi.waitFor(() => expect(sent).toEqual(['a--']))
  })

  it('Given dictation-style hypothesis revisions When changes arrive Then the field is never rewritten and the PTY converges', async () => {
    const { captures, handlers, sent } = createTerminalLiveInputCommitHarness()

    changeLiveInput(handlers, 'high')
    changeLiveInput(handlers, 'hi there')

    expect(captures).toEqual(['high', 'hi there'])
    await vi.waitFor(() => expect(sent).toEqual(['high', '\x7f\x7f there']))
  })

  it('Given a trailing space after Hangul When the change arrives Then the space commits the held syllable', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    changeLiveInput(handlers, '한 ')

    await vi.waitFor(() => expect(sent).toEqual(['한 ']))
  })

  it('Given Hangul pending text When an external terminal send is requested Then flushes composed text first', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    const flushed = await handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')

    expect(flushed).toBe(true)
    expect(sent).toEqual(['한'])
  })

  it('Given pending text cannot be sent When an external terminal send is requested Then reports failure', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })
    changeLiveInput(handlers, '한')

    const flushed = await handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')

    expect(flushed).toBe(false)
    expect(sent).toEqual(['한'])
  })

  it('Given non-Hangul IME text When changes arrive Then mirrors immediately without a settle window', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    changeLiveInput(handlers, '你好')

    await vi.waitFor(() => expect(sent).toEqual(['你好']))
  })

  it('Given a held syllable When the hook unmounts Then cancels the settle timer', async () => {
    vi.useFakeTimers()
    const { handlers, sent, unmount } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    unmount()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sent).toEqual([])
  })

  it('Given Backspace with field text When the key arrives Then edits locally without terminal bytes', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Backspace' } })

    await vi.waitFor(() => expect(sent).toEqual([]))
  })

  it('Given Tab with a held syllable When the key arrives Then commits the syllable before the tab bytes', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Tab' } })

    await vi.waitFor(() => expect(sent).toEqual(['한', '\t']))
  })

  it('Given Hangul pending When the tab type lags to undefined Then keeps the composition state', async () => {
    const { handlers, sent, setActiveSessionTabType } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    setActiveSessionTabType(undefined)
    handlers.handleLiveInputSubmit()

    await vi.waitFor(() => expect(sent).toEqual(['한', '\r']))
  })

  it('Given Hangul pending When the tab genuinely changes to non-terminal Then clears the composition state', async () => {
    const { handlers, sent, setActiveSessionTabType } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    setActiveSessionTabType('chat')
    handlers.handleLiveInputSubmit()

    await vi.waitFor(() => expect(sent).toEqual(['\r']))
  })

  it('Given bytes lost in a silent stall When the disconnect is detected Then the first post-recovery send carries no stale fragment or phantom erases', async () => {
    // Simulate a stalled link where mirror bytes never reach PTY acceptance.
    const { captures, handlers, sent, setConnected, setSendResult } =
      createTerminalLiveInputCommitHarness({ sendResult: false })
    changeLiveInput(handlers, 'XYZZY')
    await vi.waitFor(() => expect(sent).toEqual(['XYZZY']))

    setConnected(false)
    setSendResult(true)
    setConnected(true)

    // Fresh typing after reconnect must neither replay stale bytes nor DEL characters that never arrived.
    expect(captures.at(-1)).toBe('')
    const sentBeforeRecovery = sent.length
    changeLiveInput(handlers, 'echo CLEANLINE')
    await vi.waitFor(() => expect(sent.slice(sentBeforeRecovery)).toEqual(['echo CLEANLINE']))
  })

  it('Given a held syllable during an outage When the disconnect is detected Then the settle timer cannot commit it later', async () => {
    vi.useFakeTimers()
    const { handlers, sent, setConnected } = createTerminalLiveInputCommitHarness({
      sendResult: false
    })
    changeLiveInput(handlers, '한')

    setConnected(false)
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)

    expect(sent).toEqual([])
  })
})
