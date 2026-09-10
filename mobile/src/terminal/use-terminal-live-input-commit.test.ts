import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS } from './terminal-live-preedit-mirror'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

type TerminalLiveInputCommitHandlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

/** `isComposing` omitted models a platform that reports no marked-text range. */
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
  // Refs never re-render; only these variables re-run the hook's clear effects.
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
      // Ref and prop derive from the same activeSessionTab in the real route, so
      // they go null together during tab-list lag — keep the harness coupled.
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
  })

  it('Given Hangul composition and no marked-text report When steps arrive Then no jamo leaks', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: ㅎ→하→한→한ㄱ→한그→한글 (no settle pause between steps)
    for (const fieldText of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
      changeLiveInput(handlers, fieldText)
      await vi.advanceTimersByTimeAsync(50)
    }

    // Then: the settle timer commits the run intact; no jamo and no DEL repair
    await vi.waitFor(() => expect(sent).toEqual(['한글']))
  })

  it('Given Japanese romaji When the marked-text range is reported Then no reading reaches the terminal', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: `sa` reads as さ, converts to 桜, and only then commits
    for (const fieldText of ['s', 'さ', 'さく', 'さくら']) {
      changeLiveInput(handlers, fieldText, true)
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS * 4)
    changeLiveInput(handlers, '桜', false)

    // Then: the reading never reached the PTY, so nothing had to be erased
    await vi.waitFor(() => expect(sent).toEqual(['桜']))
  })

  it('Given a reported preedit that goes idle When the settle delay passes Then nothing is committed on a timer', async () => {
    // Given: preedit is not text yet, so no timer may promote it
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    changeLiveInput(handlers, 'nihao', true)
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS * 10)

    // Then
    expect(sent).toEqual([])
  })

  it('Given an iOS pinyin preedit When accessory Backspace edits it Then only the candidate reaches the terminal', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, 'ni hao', true)

    // When
    await handlers.handleLiveInputAccessoryBytes({ bytes: '\x7f', localEdit: 'backspace' })
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS * 2)
    changeLiveInput(handlers, '你好', false)

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['你好']))
  })

  it('Given an Android heuristic hold When accessory Backspace edits it Then the remaining text still settles', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한글')

    // When
    await handlers.handleLiveInputAccessoryBytes({ bytes: '\x7f', localEdit: 'backspace' })
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한']))
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
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    // When
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given a timer-committed syllable When composition continues Then corrects with DEL and recommits', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '하')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)
    await vi.waitFor(() => expect(sent).toEqual(['하']))

    // When
    changeLiveInput(handlers, '한')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['하', '\x7f', '한']))
  })

  it('Given Hangul pending text When submit is requested Then sends composed text before carriage return', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    // When
    const accepted = await handlers.handleLiveInputSubmit()

    // Then
    expect(accepted).toBe(true)
    await vi.waitFor(() => expect(sent).toEqual(['한', '\r']))
  })

  it('Given no pending text When submit is requested Then sends only carriage return', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    const accepted = await handlers.handleLiveInputSubmit()

    // Then
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
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })
    changeLiveInput(handlers, '한')

    // When
    const accepted = await handlers.handleLiveInputSubmit()

    // Then: the held commit went out but was not accepted, so no \r follows
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
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    changeLiveInput(handlers, 'a')
    changeLiveInput(handlers, 'ab')

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['a', 'b']))
  })

  it('Given iOS smart-dash text When the change arrives Then the capture echoes the raw field text and the PTY gets normalized bytes', async () => {
    // Given
    const { captures, handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: iOS smart punctuation rewrote "--" into an en dash inside the field
    changeLiveInput(handlers, 'a–')

    // Then: writing "a--" back into the controlled value would kill an active
    // iOS dictation/IME session, so the capture must keep what iOS produced
    expect(captures).toEqual(['a–'])
    await vi.waitFor(() => expect(sent).toEqual(['a--']))
  })

  it('Given dictation-style hypothesis revisions When changes arrive Then the field is never rewritten and the PTY converges', async () => {
    // Given
    const { captures, handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: iOS dictation replaces its hypothesis as recognition refines
    changeLiveInput(handlers, 'high')
    changeLiveInput(handlers, 'hi there')

    // Then: captures only echo the field; the mirror repairs the PTY with DELs
    expect(captures).toEqual(['high', 'hi there'])
    await vi.waitFor(() => expect(sent).toEqual(['high', '\x7f\x7f there']))
  })

  it('Given a trailing space after Hangul When the change arrives Then the space commits the held syllable', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    // When
    changeLiveInput(handlers, '한 ')

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한 ']))
  })

  it('Given Hangul pending text When an external terminal send is requested Then flushes composed text first', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    // When
    const flushed = await handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')

    // Then
    expect(flushed).toBe(true)
    expect(sent).toEqual(['한'])
  })

  it('Given pending text cannot be sent When an external terminal send is requested Then reports failure', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })
    changeLiveInput(handlers, '한')

    // When
    const flushed = await handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')

    // Then
    expect(flushed).toBe(false)
    expect(sent).toEqual(['한'])
  })

  it('Given non-Hangul IME text When changes arrive Then mirrors immediately without a settle window', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    changeLiveInput(handlers, '你好')

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['你好']))
  })

  it('Given a held syllable When the hook unmounts Then cancels the settle timer', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent, unmount } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    // When
    unmount()
    await vi.advanceTimersByTimeAsync(1_000)

    // Then
    expect(sent).toEqual([])
  })

  it('Given Backspace with field text When the key arrives Then edits locally without terminal bytes', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    // When
    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Backspace' } })

    // Then
    await vi.waitFor(() => expect(sent).toEqual([]))
  })

  it('Given Tab with a held syllable When the key arrives Then commits the syllable before the tab bytes', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    // When
    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Tab' } })

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한', '\t']))
  })

  it('Given Hangul pending When the tab type lags to undefined Then keeps the composition state', async () => {
    // Given: '한' held while the active tab is still a terminal
    const { handlers, sent, setActiveSessionTabType } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    // When: the mobile tab list momentarily yields no active tab object
    setActiveSessionTabType(undefined)
    handlers.handleLiveInputSubmit()

    // Then: an unknown tab type is not "left the terminal", so pending still flushes
    await vi.waitFor(() => expect(sent).toEqual(['한', '\r']))
  })

  it('Given Hangul pending When the tab genuinely changes to non-terminal Then clears the composition state', async () => {
    // Given: '한' held while the active tab is still a terminal
    const { handlers, sent, setActiveSessionTabType } = createTerminalLiveInputCommitHarness()
    changeLiveInput(handlers, '한')

    // When: the active tab actually becomes a non-terminal (chat) tab
    setActiveSessionTabType('chat')
    handlers.handleLiveInputSubmit()

    // Then: pending was dropped, so submit sends only the carriage return
    await vi.waitFor(() => expect(sent).toEqual(['\r']))
  })

  it('Given bytes lost in a silent stall When the disconnect is detected Then the first post-recovery send carries no stale fragment or phantom erases', async () => {
    // Given: a stalled link — the mirror sends but the PTY never accepts (#6713 second defect)
    const { captures, handlers, sent, setConnected, setSendResult } =
      createTerminalLiveInputCommitHarness({ sendResult: false })
    changeLiveInput(handlers, 'XYZZY')
    await vi.waitFor(() => expect(sent).toEqual(['XYZZY']))

    // When: the outage is finally detected, then the link recovers
    setConnected(false)
    setSendResult(true)
    setConnected(true)

    // Then: the capture was wiped, and fresh typing sends verbatim bytes — not
    // 'XYZZY…' replayed and not DELs erasing PTY chars that never arrived
    expect(captures.at(-1)).toBe('')
    const sentBeforeRecovery = sent.length
    changeLiveInput(handlers, 'echo CLEANLINE')
    await vi.waitFor(() => expect(sent.slice(sentBeforeRecovery)).toEqual(['echo CLEANLINE']))
  })

  it('Given a held syllable during an outage When the disconnect is detected Then the settle timer cannot commit it later', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent, setConnected } = createTerminalLiveInputCommitHarness({
      sendResult: false
    })
    changeLiveInput(handlers, '한')

    // When
    setConnected(false)
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)

    // Then: the outage cleared the held text before the timer could send it
    expect(sent).toEqual([])
  })
})
