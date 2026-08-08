import { createElement, type RefObject } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

type Handlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

type DeferredSend = {
  readonly resolve: (sent: boolean) => void
  readonly sender: TerminalLiveInputSender
  readonly started: string[]
}

function createDeferredSend(): DeferredSend {
  const started: string[] = []
  let resolve: (sent: boolean) => void = () => {
    throw new Error('terminal send did not start')
  }
  return {
    resolve: (sent) => resolve(sent),
    sender: async (_handle, bytes) =>
      new Promise<boolean>((resolveSend) => {
        started.push(bytes)
        resolve = resolveSend
      }),
    started
  }
}

function createHarness(sender: TerminalLiveInputSender): Handlers {
  const activeHandle = 'terminal-a'
  const activeHandleRef: RefObject<string | null> = { current: activeHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const liveInputTerminalHandles = new Set([activeHandle])
  let handlers: Handlers | null = null

  function Harness(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      connected: true,
      liveInputRef: { current: { setNativeProps: vi.fn() } },
      liveInputTerminalHandles,
      liveInputTerminalHandlesRef: { current: liveInputTerminalHandles },
      platform: 'android',
      sendLiveTerminalInputRef: { current: sender },
      setLiveInputCapture: () => {}
    })
    return null
  }

  const originalConsoleError = console.error
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
      originalConsoleError(...args)
    }
  })
  try {
    act(() => {
      create(createElement(Harness))
    })
  } finally {
    consoleError.mockRestore()
  }
  if (!handlers) {
    throw new Error('terminal live input hook did not render')
  }
  return handlers
}

function change(
  handlers: Handlers,
  text: string,
  isComposing: boolean,
  replacementText: string,
  start: number,
  end: number
): void {
  handlers.handleLiveInputChange({
    nativeEvent: {
      text,
      isComposing,
      replacementText,
      replacementRange: { start, end }
    }
  })
}

describe('terminal live native IME accessory order', () => {
  it('sends only committed Hangul and holds accessory bytes behind that send', async () => {
    const pendingSend = createDeferredSend()
    const handlers = createHarness(pendingSend.sender)

    change(handlers, 'ㅎ', true, 'ㅎ', 0, 0)
    change(handlers, '하', true, '하', 0, 1)
    change(handlers, '한', true, '한', 0, 1)
    expect(pendingSend.started).toEqual([])

    change(handlers, '한', false, '한', 0, 1)
    expect(pendingSend.started).toEqual(['한'])

    let accessorySettled = false
    const accessory = handlers.handleLiveInputAccessoryBytes({ bytes: '\x1b' }).then((result) => {
      accessorySettled = true
      return result
    })
    await Promise.resolve()
    expect(accessorySettled).toBe(false)

    pendingSend.resolve(true)
    await expect(accessory).resolves.toEqual({ kind: 'allow-raw' })
    expect(pendingSend.started).toEqual(['한'])
  })

  it('suppresses accessory bytes when the preceding commit fails', async () => {
    const pendingSend = createDeferredSend()
    const handlers = createHarness(pendingSend.sender)

    change(handlers, '한', false, '한', 0, 0)
    const accessory = handlers.handleLiveInputAccessoryBytes({ bytes: '\x1b' })
    pendingSend.resolve(false)

    await expect(accessory).resolves.toEqual({ kind: 'suppress-raw' })
    expect(pendingSend.started).toEqual(['한'])
  })
})
