import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS } from './terminal-live-hangul-mirror'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

type DeferredSend = {
  readonly bytes: string
  readonly resolve: (value: boolean) => void
}

type TerminalLiveInputCommitHarness = {
  readonly captures: readonly string[]
  readonly handlers: ReturnType<typeof useTerminalLiveInputCommit<string>>
  readonly sent: readonly string[]
  readonly invokeOrder: readonly string[]
  readonly pendingSends: DeferredSend[]
  readonly resolveNextSend: (value?: boolean) => void
  readonly setActiveSessionTabType: (next: string | undefined) => void
  readonly setConnected: (next: boolean) => void
  readonly setSendResult: (next: boolean) => void
  readonly unmount: () => void
}

type TerminalLiveInputCommitHarnessOptions = {
  readonly sendResult?: boolean
  /** When set, overrides sendResult per payload (for accept/reject control cases). */
  readonly acceptSend?: (bytes: string) => boolean
  /** Hold each send until resolveNextSend — for queue-ordering race tests. */
  readonly deferSends?: boolean
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

function createTerminalLiveInputCommitHarness({
  sendResult = true,
  acceptSend,
  deferSends = false
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
  const invokeOrder: string[] = []
  const pendingSends: DeferredSend[] = []
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      invokeOrder.push(bytes)
      if (deferSends) {
        return new Promise<boolean>((resolve) => {
          pendingSends.push({
            bytes,
            resolve: (value) => {
              sent.push(bytes)
              resolve(value)
            }
          })
        })
      }
      sent.push(bytes)
      return acceptSend ? acceptSend(bytes) : currentSendResult
    }
  }
  // Refs never re-render; only these variables re-run the hook's clear effects.
  let currentActiveSessionTabType: string | undefined = 'terminal'
  let currentConnected = true
  let handlers: ReturnType<typeof useTerminalLiveInputCommit<string>> | null = null
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

  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    act(() => {
      renderer = create(createElement(Harness))
    })
  } finally {
    restoreConsoleError()
  }
  if (!handlers || !renderer) {
    throw new Error('terminal live input hook did not render')
  }

  return {
    captures,
    handlers,
    sent,
    invokeOrder,
    pendingSends,
    resolveNextSend: (value = true): void => {
      const next = pendingSends.shift()
      if (!next) {
        throw new Error('no deferred send to resolve')
      }
      next.resolve(value)
    },
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

  it('Given Hangul composition When steps arrive Then streams the stable prefix and never leaks jamo', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: ㅎ→하→한→한ㄱ→한그→한글 (no settle pause between steps)
    for (const fieldText of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
      handlers.handleLiveInputChange(fieldText)
      await vi.advanceTimersByTimeAsync(50)
    }

    // Then: only the stable prefix went out; the trailing syllable is held
    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given a held syllable When the settle timer elapses Then commits it to the terminal', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given a timer-committed syllable When composition continues Then corrects with DEL and recommits', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('하')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)
    await vi.waitFor(() => expect(sent).toEqual(['하']))

    // When
    handlers.handleLiveInputChange('한')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['하', '\x7f', '한']))
  })

  it('Given Hangul pending text When submit is requested Then sends composed text before carriage return', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputSubmit()

    // Then: held commit + CR are one queued payload
    await vi.waitFor(() => expect(sent).toEqual(['한\r']))
  })

  it('Given no pending text When submit is requested Then sends only carriage return', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    handlers.handleLiveInputSubmit()

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['\r']))
  })

  it('Given a rejected held-text submit When the combined payload fails Then still only one ordered attempt', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputSubmit()
    await Promise.resolve()
    await Promise.resolve()

    // Then: held+\r is one queued payload (cannot suppress only CR after a failed held half)
    await vi.waitFor(() => expect(sent).toEqual(['한\r']))
  })

  it('Given ASCII typing When changes arrive Then mirrors immediately', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    handlers.handleLiveInputChange('a')
    handlers.handleLiveInputChange('ab')

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['a', 'b']))
  })

  it('Given iOS smart-dash text When the change arrives Then the capture echoes the raw field text and the PTY gets normalized bytes', async () => {
    // Given
    const { captures, handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: iOS smart punctuation rewrote "--" into an en dash inside the field
    handlers.handleLiveInputChange('a–')

    // Then: writing "a--" back into the controlled value would kill an active
    // iOS dictation/IME session, so the capture must keep what iOS produced
    expect(captures).toEqual(['a–'])
    await vi.waitFor(() => expect(sent).toEqual(['a--']))
  })

  it('Given dictation-style hypothesis revisions When changes arrive Then the field is never rewritten and the PTY converges', async () => {
    // Given
    const { captures, handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: iOS dictation replaces its hypothesis as recognition refines
    handlers.handleLiveInputChange('high')
    handlers.handleLiveInputChange('hi there')

    // Then: captures only echo the field; the mirror repairs the PTY with DELs
    expect(captures).toEqual(['high', 'hi there'])
    await vi.waitFor(() => expect(sent).toEqual(['high', '\x7f\x7f there']))
  })

  it('Given a trailing space after Hangul When the change arrives Then the space commits the held syllable', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputChange('한 ')

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한 ']))
  })

  it('Given Hangul pending text When an external terminal send is requested Then flushes composed text first', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    const flushed = await handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')

    // Then
    expect(flushed).toBe(true)
    expect(sent).toEqual(['한'])
  })

  it('Given pending text cannot be sent When an external terminal send is requested Then reports failure', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })
    handlers.handleLiveInputChange('한')

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
    handlers.handleLiveInputChange('你好')

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['你好']))
  })

  it('Given a held syllable When the hook unmounts Then cancels the settle timer', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent, unmount } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    unmount()
    await vi.advanceTimersByTimeAsync(1_000)

    // Then
    expect(sent).toEqual([])
  })

  it('Given Backspace with field text When the key arrives Then edits locally without terminal bytes', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Backspace' } })

    // Then
    await vi.waitFor(() => expect(sent).toEqual([]))
  })

  it('Given Tab with a held syllable When the key arrives Then commits the syllable before the tab bytes', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Tab' } })

    // Then: held preedit is not on the PTY — one ordered payload holds-before-Tab
    await vi.waitFor(() => expect(sent).toEqual(['한\t']))
  })

  it('Given Hangul pending When the tab type lags to undefined Then keeps the composition state', async () => {
    // Given: '한' held while the active tab is still a terminal
    const { handlers, sent, setActiveSessionTabType } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When: the mobile tab list momentarily yields no active tab object
    setActiveSessionTabType(undefined)
    handlers.handleLiveInputSubmit()

    // Then: an unknown tab type is not "left the terminal", so pending still flushes
    await vi.waitFor(() => expect(sent).toEqual(['한\r']))
  })

  it('Given Hangul pending When the tab genuinely changes to non-terminal Then clears the composition state', async () => {
    // Given: '한' held while the active tab is still a terminal
    const { handlers, sent, setActiveSessionTabType } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When: the active tab actually becomes a non-terminal (chat) tab
    setActiveSessionTabType('chat')
    handlers.handleLiveInputSubmit()

    // Then: pending was dropped and the surface is not live — no control is queued
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toEqual([])
  })

  /**
   * RN 0.83.9: onChangeText then onSelectionChange for the edit. Simulate the
   * paired end-of-field selection, then a later cursor-only trackpad move.
   */
  async function typeFieldThenMoveCaret(
    handlers: ReturnType<typeof createTerminalLiveInputCommitHarness>['handlers'],
    fieldText: string,
    nextCollapsedUtf16: number
  ): Promise<void> {
    handlers.handleLiveInputChange(fieldText)
    // Paired selection after the text change (caret at end) — not a trackpad move.
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: fieldText.length, end: fieldText.length } }
    })
    await Promise.resolve()
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: nextCollapsedUtf16, end: nextCollapsedUtf16 } }
    })
  }

  it('Given end-to-middle trackpad move When selection collapses Then sends ordered ArrowLeft bytes', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    await typeFieldThenMoveCaret(handlers, 'abcdef', 3)

    await vi.waitFor(() => expect(sent).toEqual(['abcdef', '\x1b[D'.repeat(3)]))
  })

  it('Given repeated selection at the same index Then sends nothing more', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    await typeFieldThenMoveCaret(handlers, 'abc', 1)
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2)]))

    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 1, end: 1 } }
    })
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 1, end: 1 } }
    })

    await Promise.resolve()
    expect(sent).toEqual(['abc', '\x1b[D'.repeat(2)])
  })

  it('Given middle caret When moved right Then sends ordered ArrowRight bytes', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    await typeFieldThenMoveCaret(handlers, 'abcdef', 2)
    await vi.waitFor(() => expect(sent).toEqual(['abcdef', '\x1b[D'.repeat(4)]))

    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 5, end: 5 } }
    })

    await vi.waitFor(() => expect(sent).toEqual(['abcdef', '\x1b[D'.repeat(4), '\x1b[C'.repeat(3)]))
  })

  it('Given middle insertion When text changes Then PTY converges to abcXdef with caret after X', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    await typeFieldThenMoveCaret(handlers, 'abcdef', 3)
    await vi.waitFor(() => expect(sent).toEqual(['abcdef', '\x1b[D'.repeat(3)]))

    handlers.handleLiveInputChange('abcXdef')
    // Paired selection after insert (RN order) must not emit a second arrow plan.
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 4, end: 4 } }
    })

    await vi.waitFor(() =>
      expect(sent).toEqual([
        'abcdef',
        '\x1b[D'.repeat(3),
        '\x1b[C'.repeat(3) + '\x7f'.repeat(3) + 'Xdef' + '\x1b[D'.repeat(3)
      ])
    )
  })

  it('Given middle deletion When text shortens Then restores, erases, and reseats the caret', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    await typeFieldThenMoveCaret(handlers, 'abXcd', 3)
    await vi.waitFor(() => expect(sent).toEqual(['abXcd', '\x1b[D'.repeat(2)]))

    handlers.handleLiveInputChange('abcd')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 2, end: 2 } }
    })

    await vi.waitFor(() =>
      expect(sent).toEqual([
        'abXcd',
        '\x1b[D'.repeat(2),
        '\x1b[C'.repeat(2) + '\x7f'.repeat(3) + 'cd' + '\x1b[D'.repeat(2)
      ])
    )
  })

  it('Given emoji field When caret crosses the emoji Then arrow counts are code-point safe', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    const text = 'a👍b'
    // UTF-16: a=0..1, 👍=1..3, b=3..4 — caret before b is utf16 offset 3
    await typeFieldThenMoveCaret(handlers, text, 3)

    await vi.waitFor(() => expect(sent).toEqual([text, '\x1b[D']))
  })

  it('Given held Hangul When selection moves left Then flushes the syllable before arrows', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 1, end: 1 } }
    })
    handlers.handleLiveInputChange('한글')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 2, end: 2 } }
    })
    await vi.waitFor(() => expect(sent).toEqual(['한']))
    await Promise.resolve()

    // Cursor-only move (no preceding text change) — flush held then ArrowLeft.
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 1, end: 1 } }
    })

    await vi.waitFor(() => expect(sent).toEqual(['한', '글' + '\x1b[D']))
  })

  it('Given held Hangul When end-of-field selection repeats Then does not flush early', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 1, end: 1 } }
    })
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 1, end: 1 } }
    })

    await Promise.resolve()
    expect(sent).toEqual([])
  })

  it('Given Hangul composition When paired selections follow each change Then does not flush or leak preedit jamo', async () => {
    // Given / When: RN delivers onChange then onSelectionChange per composition step
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    for (const fieldText of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
      handlers.handleLiveInputChange(fieldText)
      handlers.handleLiveInputSelectionChange({
        nativeEvent: { selection: { start: fieldText.length, end: fieldText.length } }
      })
    }

    // Then: only the stable prefix streamed; held trailing syllable never flushed by selection
    await vi.waitFor(() => expect(sent).toEqual(['한']))
    expect(sent.some((payload) => payload.includes('ㅎ') || payload.includes('ㄱ'))).toBe(false)
  })

  it('Given physical ArrowLeft with field text When keypress and selection both fire Then sends a single arrow', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    await typeFieldThenMoveCaret(handlers, 'abc', 3)
    await vi.waitFor(() => expect(sent).toEqual(['abc']))

    // Hardware keyboards can emit both events; keypress must not PTY-send when the field owns the caret.
    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'ArrowLeft' } })
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 2, end: 2 } }
    })

    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D']))
    expect(sent.filter((payload) => payload === '\x1b[D')).toHaveLength(1)
  })

  it('Given physical ArrowRight with field text When keypress and selection both fire Then sends a single arrow', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    await typeFieldThenMoveCaret(handlers, 'abc', 1)
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2)]))

    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'ArrowRight' } })
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 2, end: 2 } }
    })

    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2), '\x1b[C']))
    expect(sent.filter((payload) => payload === '\x1b[C')).toHaveLength(1)
  })

  it('Given stale handle When selection arrives Then rejects and sends nothing', async () => {
    const { handlers, sent, setActiveSessionTabType } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('abc')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 3, end: 3 } }
    })
    await vi.waitFor(() => expect(sent).toEqual(['abc']))

    // Tab left the terminal surface — live selection must not move a foreign PTY.
    setActiveSessionTabType('chat')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 0, end: 0 } }
    })

    await Promise.resolve()
    expect(sent).toEqual(['abc'])
  })

  it('Given pending field When submit runs Then selection state resets so later arrows do not reuse it', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    await typeFieldThenMoveCaret(handlers, 'abc', 1)
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2)]))

    handlers.handleLiveInputSubmit()
    // Mid-caret restore + CR are one control payload after the trackpad lefts.
    await vi.waitFor(() =>
      expect(sent).toEqual(['abc', '\x1b[D'.repeat(2), '\x1b[C'.repeat(2) + '\r'])
    )

    handlers.handleLiveInputChange('z')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 1, end: 1 } }
    })
    await vi.waitFor(() =>
      expect(sent).toEqual(['abc', '\x1b[D'.repeat(2), '\x1b[C'.repeat(2) + '\r', 'z'])
    )
  })

  it('Given non-terminal mode change When selection fires Then sends nothing', async () => {
    const { handlers, sent, setActiveSessionTabType } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('abc')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 3, end: 3 } }
    })
    await vi.waitFor(() => expect(sent).toEqual(['abc']))
    setActiveSessionTabType('chat')

    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 0, end: 0 } }
    })

    await Promise.resolve()
    expect(sent).toEqual(['abc'])
  })

  it('Given mid-field caret When accessory Left is accepted Then next typed char starts fresh without canceling the control', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    await typeFieldThenMoveCaret(handlers, 'abc', 1)
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2)]))

    const result = await handlers.handleLiveInputAccessoryBytes({ bytes: '\x1b[D' })
    expect(result).toEqual({ kind: 'handled' })
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2), '\x1b[D']))

    // Fresh field session at the moved PTY position — no restore/suffix repair of "abc".
    handlers.handleLiveInputChange('z')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 1, end: 1 } }
    })
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2), '\x1b[D', 'z']))
    expect(sent.some((payload) => payload.includes('\x7f'))).toBe(false)
  })

  it('Given sent-only accessory control When send fails Then local session still ended so next typing is fresh', async () => {
    // Trackpad multi-arrow payload still accepts; single accessory Left rejects.
    const { handlers, sent } = createTerminalLiveInputCommitHarness({
      acceptSend: (bytes) => bytes !== '\x1b[D'
    })
    await typeFieldThenMoveCaret(handlers, 'abc', 1)
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2)]))

    const result = await handlers.handleLiveInputAccessoryBytes({ bytes: '\x1b[D' })
    expect(result).toEqual({ kind: 'handled' })
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2), '\x1b[D']))

    // Session ended on queue regardless of accept — no suffix repair against "abc".
    handlers.handleLiveInputChange('z')
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D'.repeat(2), '\x1b[D', 'z']))
  })

  it('Given accepted Tab with field text When next char is typed Then starts a fresh field session', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('abc')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 3, end: 3 } }
    })
    await vi.waitFor(() => expect(sent).toEqual(['abc']))

    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Tab' } })
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\t']))

    handlers.handleLiveInputChange('z')
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\t', 'z']))
  })

  it('Given accepted Escape with field text When next char is typed Then starts a fresh field session', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('abc')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 3, end: 3 } }
    })
    await vi.waitFor(() => expect(sent).toEqual(['abc']))

    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Escape' } })
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b']))

    handlers.handleLiveInputChange('z')
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b', 'z']))
  })

  it('Given failed non-arrow special control When send is rejected Then session was still cleared for a fresh next edit', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness({
      acceptSend: (bytes) => bytes !== '\x1b'
    })
    handlers.handleLiveInputChange('abc')
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 3, end: 3 } }
    })
    await vi.waitFor(() => expect(sent).toEqual(['abc']))

    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Escape' } })
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b']))

    handlers.handleLiveInputChange('z')
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b', 'z']))
  })

  it('Given deferred accessory Left When new Hangul arrives Then control settles before the new session payload', async () => {
    const { handlers, sent, invokeOrder, pendingSends, resolveNextSend } =
      createTerminalLiveInputCommitHarness({ deferSends: true })

    handlers.handleLiveInputChange('abc')
    await vi.waitFor(() => expect(pendingSends.length).toBe(1))
    resolveNextSend(true)
    await vi.waitFor(() => expect(sent).toEqual(['abc']))
    handlers.handleLiveInputSelectionChange({
      nativeEvent: { selection: { start: 3, end: 3 } }
    })

    const accessoryPromise = handlers.handleLiveInputAccessoryBytes({ bytes: '\x1b[D' })
    await vi.waitFor(() => expect(pendingSends.map((p) => p.bytes)).toEqual(['\x1b[D']))

    // New IME session while control is still pending — must not be invoked yet.
    handlers.handleLiveInputChange('한')
    await Promise.resolve()
    expect(invokeOrder).toEqual(['abc', '\x1b[D'])
    expect(pendingSends).toHaveLength(1)

    resolveNextSend(true)
    await accessoryPromise
    await vi.waitFor(() => expect(pendingSends.map((p) => p.bytes)).toEqual(['한']))
    resolveNextSend(true)
    await vi.waitFor(() => expect(sent).toEqual(['abc', '\x1b[D', '한']))
  })

  it('Given deferred submit When new Hangul arrives Then submit payload settles before the new Hangul', async () => {
    const { handlers, sent, invokeOrder, pendingSends, resolveNextSend } =
      createTerminalLiveInputCommitHarness({ deferSends: true })

    handlers.handleLiveInputChange('한')
    await vi.waitFor(() => expect(pendingSends.length).toBe(0))
    // Held is not sent until commit; submit queues held+\r as one payload.
    handlers.handleLiveInputSubmit()
    await vi.waitFor(() => expect(pendingSends.map((p) => p.bytes)).toEqual(['한\r']))

    handlers.handleLiveInputChange('가')
    await Promise.resolve()
    expect(invokeOrder).toEqual(['한\r'])
    expect(pendingSends).toHaveLength(1)

    resolveNextSend(true)
    await vi.waitFor(() => expect(pendingSends.map((p) => p.bytes)).toEqual(['가']))
    resolveNextSend(true)
    await vi.waitFor(() => expect(sent).toEqual(['한\r', '가']))
  })

  it('Given deferred external flush When new Hangul arrives Then flush settles before the new session', async () => {
    const { handlers, sent, invokeOrder, pendingSends, resolveNextSend } =
      createTerminalLiveInputCommitHarness({ deferSends: true })

    handlers.handleLiveInputChange('한')
    const flushPromise = handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')
    await vi.waitFor(() => expect(pendingSends.map((p) => p.bytes)).toEqual(['한']))

    handlers.handleLiveInputChange('글')
    await Promise.resolve()
    expect(invokeOrder).toEqual(['한'])
    expect(pendingSends).toHaveLength(1)

    resolveNextSend(true)
    await flushPromise
    await vi.waitFor(() => expect(pendingSends.map((p) => p.bytes)).toEqual(['글']))
    resolveNextSend(true)
    await vi.waitFor(() => expect(sent).toEqual(['한', '글']))
  })

  it('Given bytes lost in a silent stall When the disconnect is detected Then the first post-recovery send carries no stale fragment or phantom erases', async () => {
    // Given: a stalled link — the mirror sends but the PTY never accepts (#6713 second defect)
    const { captures, handlers, sent, setConnected, setSendResult } =
      createTerminalLiveInputCommitHarness({ sendResult: false })
    handlers.handleLiveInputChange('XYZZY')
    await vi.waitFor(() => expect(sent).toEqual(['XYZZY']))

    // When: the outage is finally detected, then the link recovers
    setConnected(false)
    setSendResult(true)
    setConnected(true)

    // Then: the capture was wiped, and fresh typing sends verbatim bytes — not
    // 'XYZZY…' replayed and not DELs erasing PTY chars that never arrived
    expect(captures.at(-1)).toBe('')
    const sentBeforeRecovery = sent.length
    handlers.handleLiveInputChange('echo CLEANLINE')
    await vi.waitFor(() => expect(sent.slice(sentBeforeRecovery)).toEqual(['echo CLEANLINE']))
  })

  it('Given a held syllable during an outage When the disconnect is detected Then the settle timer cannot commit it later', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent, setConnected } = createTerminalLiveInputCommitHarness({
      sendResult: false
    })
    handlers.handleLiveInputChange('한')

    // When
    setConnected(false)
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)

    // Then: the outage cleared the held text before the timer could send it
    expect(sent).toEqual([])
  })
})
