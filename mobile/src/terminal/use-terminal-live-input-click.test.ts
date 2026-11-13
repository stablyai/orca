import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInputInstance } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

vi.mock('../platform/text-input/live-input-composing-range', () => ({
  reportedLiveInputComposing: (isComposing: boolean | undefined) => isComposing
}))

type Handlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

const CLICK = '\x1b[<0;9;31M\x1b[<0;9;31m'

type ClickHarness = {
  readonly captures: readonly string[]
  readonly handlers: Handlers
  readonly sent: readonly string[]
  readonly unmount: () => void
}

function createClickHarness(sender?: TerminalLiveInputSender): ClickHarness {
  const activeHandle = 'terminal-a'
  const activeHandleRef: RefObject<string | null> = { current: activeHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const captures: string[] = []
  const setLiveInputCapture = (text: string): void => {
    captures.push(text)
  }
  const liveInputRef: RefObject<TextInputInstance | null> = { current: null }
  const sent: string[] = []
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (handle, bytes, origin) => {
      sent.push(bytes)
      return sender ? sender(handle, bytes, origin) : true
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
      await vi.waitFor(() => expect(sent.join('')).toBe(`abc${CLICK}X`))
    } finally {
      unmount()
    }
  })

  it('retires a queued click and later text when their prefix fails', async () => {
    let fail = (): void => {}
    const { handlers, sent, unmount } = createClickHarness((_handle, bytes) =>
      bytes === 'abc'
        ? new Promise<boolean>((resolve) => {
            fail = () => resolve(false)
          })
        : Promise.resolve(true)
    )
    try {
      change(handlers, 'abc')
      const clicked = handlers.sendLiveInputClick('terminal-a', CLICK)
      change(handlers, 'X')
      fail()
      expect(await clicked).toBe(false)
      expect(sent).toEqual(['abc'])
      change(handlers, 'fresh')
      await vi.waitFor(() => expect(sent).toEqual(['abc', 'fresh']))
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

  it('preserves immediate matching DOM input without a key event', async () => {
    const { handlers, sent, captures, unmount } = createClickHarness()
    try {
      change(handlers, 'x')
      await handlers.sendLiveInputClick('terminal-a', CLICK)
      handlers.handleLiveInputChange({
        nativeEvent: { text: 'x', isComposing: false, inputType: 'insertText' }
      })
      await vi.waitFor(() => expect(sent.join('')).toBe(`x${CLICK}x`))
      expect(captures.at(-1)).toBe('x')
    } finally {
      unmount()
    }
  })
})
