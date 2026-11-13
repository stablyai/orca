import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInputInstance } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

vi.mock('../platform/text-input/live-input-composing-range', () => ({
  reportedLiveInputComposing: (isComposing: boolean | undefined) => isComposing
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
  readonly handlers: TerminalLiveInputCommitHandlers
  readonly sent: readonly string[]
  readonly unmount: () => void
}

type TerminalLiveInputCommitHarnessOptions = {
  readonly sender?: TerminalLiveInputSender
  readonly bracketedPaste?: boolean
}

function createTerminalLiveInputCommitHarness({
  sender,
  bracketedPaste = false
}: TerminalLiveInputCommitHarnessOptions = {}): TerminalLiveInputCommitHarness {
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
    current: async (handle, bytes) => {
      sent.push(bytes)
      return sender ? sender(handle, bytes) : true
    }
  }
  let handlers: TerminalLiveInputCommitHandlers | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      connected: true,
      framesLivePaste: () => bracketedPaste,
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
    handlers,
    sent,
    unmount: () => {
      act(() => renderer?.unmount())
    }
  }
}

describe('terminal live input commit hook', () => {
  it.each(['refused', 'timed-out'] as const)(
    'ends a %s field session once and drops edits and Return that depended on it',
    async (failure) => {
      let fail = (): void => {}
      const pending = new Promise<boolean>((resolve, reject) => {
        fail = () => (failure === 'refused' ? resolve(false) : reject(new Error('timeout')))
      })
      const sender = vi
        .fn<TerminalLiveInputSender>()
        .mockReturnValueOnce(pending)
        .mockResolvedValue(true)
      const { handlers, sent, captures, unmount } = createTerminalLiveInputCommitHarness({
        sender
      })
      changeLiveInput(handlers, 'abc', false)
      changeLiveInput(handlers, 'ab', false)
      const submit = handlers.handleLiveInputSubmit()

      fail()
      await expect(submit).resolves.toBe(false)
      expect(sent).toEqual(['abc'])
      expect(captures.at(-1)).toBe('')

      changeLiveInput(handlers, 'ab', false)
      changeLiveInput(handlers, 'x', false)
      await vi.waitFor(() => expect(sent).toEqual(['abc', 'x']))
      changeLiveInput(handlers, '', false)
      await vi.waitFor(() => expect(sent).toEqual(['abc', 'x', '\x7f']))
      unmount()
    }
  )

  it('frames held unreported paste before an immediate click and starts the next mirror clean', async () => {
    vi.useFakeTimers()
    const { handlers, sent, captures, unmount } = createTerminalLiveInputCommitHarness({
      bracketedPaste: true
    })
    const text = 'é'.repeat(600)
    try {
      changeLiveInput(handlers, text)
      expect(sent).toEqual([])
      await handlers.sendLiveInputClick('terminal-a', 'CLICK')
      expect(sent).toEqual([`\x1b[200~${text}\x1b[201~`, 'CLICK'])
      expect(captures.at(-1)).toBe('')
      changeLiveInput(handlers, 'x', false)
      await vi.advanceTimersByTimeAsync(600)
      expect(sent).toEqual([`\x1b[200~${text}\x1b[201~`, 'CLICK', 'x'])
    } finally {
      unmount()
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})
