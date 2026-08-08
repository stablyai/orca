/**
 * #7094 — mobile terminal keystrokes vanish when typed fast ("only `l` instead of `ls`").
 *
 * `queueSend` chains every keystroke behind the previous send, and a send that resolves false or
 * throws aborts the whole queue behind it — the bytes are never attempted and the error is
 * swallowed. Only keystrokes queued while a doomed send is still in flight are lost, which is why
 * the loss is speed-dependent.
 *
 * SCOPE LIMIT, load-bearing: this covers a transport send-queue abort, which requires a real
 * disconnect or RPC error. `REQUEST_TIMEOUT_MS = 30_000` (`transport/rpc-client.ts`) means latency
 * alone cannot reach this branch — a flapping relay produces such errors, a steady-but-slow one does
 * not. So this is consistent with the reporter's symptom class, NOT proven to be its cause; their
 * word "latency" may be their own inference.
 */
import { createElement, type RefObject } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

type Handlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

type OrdinaryKeystroke = {
  readonly text: string
  readonly replacementText: string
  readonly start: number
  readonly end: number
}

// Ordinary ASCII, no composition — the reporter typed `ls`, not an IME sequence.
const ORDINARY_ABC_TRACE: readonly OrdinaryKeystroke[] = [
  { text: 'a', replacementText: 'a', start: 0, end: 0 },
  { text: 'ab', replacementText: 'b', start: 1, end: 1 },
  { text: 'abc', replacementText: 'c', start: 2, end: 2 }
]

const LATER_KEYSTROKE: OrdinaryKeystroke = {
  text: 'abcd',
  replacementText: 'd',
  start: 3,
  end: 3
}

function createLiveInputHarness(sender: TerminalLiveInputSender): Handlers {
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

function type(handlers: Handlers, keystroke: OrdinaryKeystroke): void {
  handlers.handleLiveInputChange({
    nativeEvent: {
      text: keystroke.text,
      isComposing: false,
      replacementText: keystroke.replacementText,
      replacementRange: { start: keystroke.start, end: keystroke.end }
    }
  })
}

/** Holds each send open so keystrokes queue behind it, exactly as fast typing does. */
function createHeldSender(): {
  readonly attempted: string[]
  readonly settle: (delivered: boolean) => void
  readonly sender: TerminalLiveInputSender
} {
  const attempted: string[] = []
  const waiting: Array<(delivered: boolean) => void> = []
  return {
    attempted,
    settle: (delivered) => {
      const resolve = waiting.shift()
      if (!resolve) {
        throw new Error('settle() called with no send in flight')
      }
      resolve(delivered)
    },
    sender: async (_handle, bytes) =>
      new Promise<boolean>((resolve) => {
        attempted.push(bytes)
        waiting.push(resolve)
      })
  }
}

// The abort resolves through promise microtasks only — no timers, so draining ticks is exact.
async function flushSendChain(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve()
  }
}

describe('#7094 mobile live input drops keystrokes queued behind a failed send', () => {
  it('never attempts the keystrokes queued behind a send that fails', async () => {
    const { attempted, settle, sender } = createHeldSender()
    const handlers = createLiveInputHarness(sender)

    for (const keystroke of ORDINARY_ABC_TRACE) {
      type(handlers, keystroke)
    }
    expect(attempted).toEqual(['a'])

    settle(false)
    await flushSendChain()

    // `b` and `c` are discarded without ever reaching the transport, and nothing reports it.
    expect(attempted).toEqual(['a'])
  })

  it('still delivers every keystroke in order when the sends succeed', async () => {
    const { attempted, settle, sender } = createHeldSender()
    const handlers = createLiveInputHarness(sender)

    for (const keystroke of ORDINARY_ABC_TRACE) {
      type(handlers, keystroke)
    }
    expect(attempted).toEqual(['a'])

    settle(true)
    await flushSendChain()
    expect(attempted).toEqual(['a', 'b'])

    settle(true)
    await flushSendChain()
    expect(attempted).toEqual(['a', 'b', 'c'])
  })

  it('swallows a throwing send and drops the keystrokes queued behind it', async () => {
    const attempted: string[] = []
    const sender: TerminalLiveInputSender = async (_handle, bytes) => {
      attempted.push(bytes)
      throw new Error('relay dropped the frame')
    }
    const handlers = createLiveInputHarness(sender)

    for (const keystroke of ORDINARY_ABC_TRACE) {
      type(handlers, keystroke)
    }
    await flushSendChain()

    expect(attempted).toEqual(['a'])
  })

  it('loses only the keystrokes queued during the failure, so slow typing survives it', async () => {
    const { attempted, settle, sender } = createHeldSender()
    const handlers = createLiveInputHarness(sender)

    for (const keystroke of ORDINARY_ABC_TRACE) {
      type(handlers, keystroke)
    }
    settle(false)
    await flushSendChain()
    expect(attempted).toEqual(['a'])

    // Typed after the aborted chain settled: the path is alive, so the drop above is a real
    // abort rather than a dead queue.
    type(handlers, LATER_KEYSTROKE)
    expect(attempted).toEqual(['a', 'd'])
  })
})
