import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputCaptureHandle } from './terminal-live-input-capture-handle'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalRevisionedInputCommit } from './use-terminal-revisioned-input-commit'

function deferredBoolean(): {
  readonly promise: Promise<boolean>
  readonly resolve: (value: boolean) => void
} {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createHarness(send: TerminalLiveInputSender): {
  readonly captures: string[]
  readonly handlers: ReturnType<typeof useTerminalRevisionedInputCommit<string>>
  readonly nativeTexts: string[]
  readonly unmount: () => void
} {
  const activeHandle = 'terminal-a'
  const captures: string[] = []
  const nativeTexts: string[] = []
  const activeHandleRef: RefObject<string | null> = { current: activeHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const liveInputTerminalHandles = new Set([activeHandle])
  const liveInputRef: RefObject<TerminalLiveInputCaptureHandle | null> = {
    current: {
      focus: () => {},
      blur: () => {},
      setNativeProps: ({ text }) => {
        if (text !== undefined) {
          nativeTexts.push(text)
        }
      }
    }
  }
  let handlers: ReturnType<typeof useTerminalRevisionedInputCommit<string>> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useTerminalRevisionedInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      liveInputRef,
      liveInputTerminalHandles,
      liveInputTerminalHandlesRef: { current: liveInputTerminalHandles },
      sendLiveTerminalInputRef: { current: send },
      setLiveInputCapture: (text) => captures.push(text)
    })
    return null
  }

  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    act(() => {
      renderer = create(createElement(Harness))
    })
  } finally {
    consoleError.mockRestore()
  }
  if (!handlers || !renderer) {
    throw new Error('revisioned terminal input hook did not render')
  }
  return {
    captures,
    handlers,
    nativeTexts,
    unmount: () => {
      act(() => renderer?.unmount())
    }
  }
}

describe('revisioned terminal input commit hook', () => {
  it('preserves a newer native revision while an earlier flush awaits acknowledgement', async () => {
    const firstSend = deferredBoolean()
    const sent: string[] = []
    const send = vi.fn<TerminalLiveInputSender>(async (_handle, bytes) => {
      sent.push(bytes)
      return sent.length === 1 ? firstSend.promise : true
    })
    const harness = createHarness(send)

    harness.handlers.handleTerminalEditorTransaction({
      revision: 1,
      text: 'a',
      composingStart: null,
      composingEnd: null
    })
    const firstFlush = harness.handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')
    harness.handlers.handleTerminalEditorTransaction({
      revision: 2,
      text: 'ab',
      composingStart: null,
      composingEnd: null
    })

    firstSend.resolve(true)
    await expect(firstFlush).resolves.toBe(true)
    expect(harness.nativeTexts).toEqual([])

    await expect(
      harness.handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')
    ).resolves.toBe(true)
    expect(sent).toEqual(['a', 'b'])
    expect(harness.nativeTexts).toEqual([''])
    harness.unmount()
  })
})
