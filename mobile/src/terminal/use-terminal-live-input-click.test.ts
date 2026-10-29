import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

vi.mock('../platform/live-input-composing-range', () => ({
  reportedLiveInputComposing: (isComposing: boolean | undefined) => isComposing
}))

type Handlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

const CLICK = '\x1b[<0;9;31M\x1b[<0;9;31m'

type ClickHarness = {
  readonly captures: readonly string[]
  readonly handlers: Handlers
  readonly sent: readonly string[]
  readonly changeHandle: (handle: string) => void
  readonly unmount: () => void
}

function createClickHarness(sender?: TerminalLiveInputSender): ClickHarness {
  let activeHandle = 'terminal-a'
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
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (handle, bytes) => {
      sent.push(bytes)
      return sender ? sender(handle, bytes) : true
    }
  }
  let handlers: Handlers | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      connected: true,
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
    get handlers() {
      if (!handlers) {
        throw new Error('terminal live input hook did not render')
      }
      return handlers
    },
    sent,
    changeHandle: (handle) => {
      activeHandle = handle
      activeHandleRef.current = handle
      liveInputTerminalHandles.add(handle)
      liveInputTerminalHandlesRef.current.add(handle)
      act(() => renderer?.update(createElement(Harness)))
    },
    unmount: () => {
      act(() => renderer?.unmount())
    }
  }
}

function change(handlers: Handlers, text: string, isComposing = false): void {
  handlers.handleLiveInputChange({ nativeEvent: { text, isComposing } })
}

// Clicks move the TUI cursor; flush old-position input first, then restart the field mirror at the new position.
describe('terminal live input around a click', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('Given typed text When a click arrives Then later typing reaches the new cursor alone', async () => {
    const { handlers, sent, captures, unmount } = createClickHarness()
    try {
      change(handlers, 'hello world')
      await vi.waitFor(() => expect(sent.join('')).toBe('hello world'))

      await handlers.sendLiveInputClick('terminal-a', CLICK)
      expect(captures.at(-1)).toBe('')

      change(handlers, 'big ')
      await vi.waitFor(() => expect(sent.join('')).toBe('hello world' + CLICK + 'big '))
    } finally {
      unmount()
    }
  })

  it('Given a composing Hangul syllable When a click arrives Then it lands before the click', async () => {
    const { handlers, sent, unmount } = createClickHarness()
    try {
      change(handlers, '안녕하세')
      change(handlers, '안녕하세요', true)
      await vi.waitFor(() => expect(sent.join('')).toBe('안녕하세'))

      await handlers.sendLiveInputClick('terminal-a', CLICK)
      change(handlers, '네', true)
      change(handlers, '네')

      await vi.waitFor(() => expect(sent.join('')).toBe('안녕하세요' + CLICK + '네'))
    } finally {
      unmount()
    }
  })

  it('Given a send still in flight When a click arrives Then the click waits behind it', async () => {
    let release = (): void => {}
    const { handlers, sent, unmount } = createClickHarness((_handle, bytes) =>
      bytes === 'abc'
        ? new Promise<boolean>((resolve) => {
            release = () => resolve(true)
          })
        : Promise.resolve(true)
    )
    try {
      change(handlers, 'abc')
      await vi.waitFor(() => expect(sent).toEqual(['abc']))

      const clicked = handlers.sendLiveInputClick('terminal-a', CLICK)
      change(handlers, 'X')
      expect(sent).toEqual(['abc'])

      release()
      expect(await clicked).toBe(true)
      await vi.waitFor(() => expect(sent).toEqual(['abc', CLICK + 'X']))
    } finally {
      unmount()
    }
  })

  it('Given a cleared field When Backspace is pressed Then one raw erase reaches the new cursor', async () => {
    const { handlers, sent, unmount } = createClickHarness()
    try {
      change(handlers, 'hello')
      await handlers.sendLiveInputClick('terminal-a', CLICK)

      handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Backspace' } })

      await vi.waitFor(() => expect(sent.join('')).toBe('hello' + CLICK + '\x7f'))
    } finally {
      unmount()
    }
  })

  it("Given the field's stale event with its old text When it arrives after the click Then it is not retyped", async () => {
    const { handlers, sent, captures, unmount } = createClickHarness()
    try {
      change(handlers, 'hello')
      await handlers.sendLiveInputClick('terminal-a', CLICK)

      change(handlers, 'hello')
      change(handlers, 'X')

      await vi.waitFor(() => expect(sent.join('')).toBe('hello' + CLICK + 'X'))
      expect(captures.at(-1)).toBe('X')
    } finally {
      unmount()
    }
  })

  it('Given the same text typed again later When it is new input Then it is mirrored', async () => {
    vi.useFakeTimers()
    const { handlers, sent, unmount } = createClickHarness()
    try {
      change(handlers, 'ok')
      await vi.advanceTimersByTimeAsync(0)
      await handlers.sendLiveInputClick('terminal-a', CLICK)
      await vi.advanceTimersByTimeAsync(1000)

      change(handlers, 'ok')
      await vi.advanceTimersByTimeAsync(0)

      expect(sent.join('')).toBe('ok' + CLICK + 'ok')
    } finally {
      unmount()
    }
  })
  it('mirrors the same character typed again immediately after a click', async () => {
    const { handlers, sent, unmount } = createClickHarness()
    try {
      change(handlers, 'x')
      await handlers.sendLiveInputClick('terminal-a', CLICK)
      handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'x' } })
      change(handlers, 'x')
      await vi.waitFor(() => expect(sent.join('')).toBe('x' + CLICK + 'x'))
    } finally {
      unmount()
    }
  })

  it.each(['insertText', 'insertFromPaste', 'insertCompositionText'])(
    'preserves immediate matching DOM input %s without a key event',
    async (inputType) => {
      const { handlers, sent, captures, unmount } = createClickHarness()
      try {
        change(handlers, 'x')
        await handlers.sendLiveInputClick('terminal-a', CLICK)
        handlers.handleLiveInputChange({
          nativeEvent: { text: 'x', isComposing: false, inputType }
        })
        await vi.waitFor(() => expect(sent.join('')).toBe('x' + CLICK + 'x'))
        expect(captures.at(-1)).toBe('x')
      } finally {
        unmount()
      }
    }
  )

  it('does not discard matching input after switching to another terminal', async () => {
    const harness = createClickHarness()
    try {
      change(harness.handlers, 'x')
      await harness.handlers.sendLiveInputClick('terminal-a', CLICK)
      harness.changeHandle('terminal-b')
      change(harness.handlers, 'x')
      await vi.waitFor(() => expect(harness.sent.join('')).toBe('x' + CLICK + 'x'))
    } finally {
      harness.unmount()
    }
  })
})
