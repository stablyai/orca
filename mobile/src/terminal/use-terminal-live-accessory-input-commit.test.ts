import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import {
  getTerminalLiveAccessoryInactiveInputCommitResult,
  useTerminalLiveAccessoryInputCommit,
  type TerminalLiveAccessoryInputCommitResult
} from './use-terminal-live-accessory-input-commit'

type DeferredBoolean = {
  readonly promise: Promise<boolean>
  readonly resolve: (value: boolean) => void
}

function createDeferredBoolean(): DeferredBoolean {
  let resolvePromise: (value: boolean) => void = () => {
    throw new Error('deferred promise was resolved before initialization')
  }
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
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

type AccessoryInputCommitHarnessOptions = {
  readonly heldText?: string
  readonly sentText?: string
  readonly pendingHandle?: string | null
  readonly sendResult?: boolean
  readonly flushResult?: boolean
  readonly waitResult?: boolean
}

type AccessoryInputCommitHarness = {
  readonly commit: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly sent: readonly string[]
  readonly applyLiveInputMirror: ReturnType<typeof vi.fn>
  readonly flushPendingLiveInputText: ReturnType<typeof vi.fn>
  readonly waitForPendingLiveInputFlush: ReturnType<typeof vi.fn>
  readonly unmount: () => void
}

function createAccessoryInputCommitHarness({
  heldText = '',
  sentText = '',
  pendingHandle = null,
  sendResult = true,
  flushResult = true,
  waitResult = true
}: AccessoryInputCommitHarnessOptions = {}): AccessoryInputCommitHarness {
  const activeHandle = 'terminal-a'
  const heldLiveInputTextRef: RefObject<string> = { current: heldText }
  const sentLiveInputTextRef: RefObject<string> = { current: sentText }
  const pendingLiveInputHandleRef: RefObject<string | null> = { current: pendingHandle }
  const liveInputRef: RefObject<TextInput | null> = { current: null }
  const liveInputTerminalHandles = new Set([activeHandle])
  const sent: string[] = []
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sent.push(bytes)
      return sendResult
    }
  }
  const applyLiveInputMirror = vi.fn((_handle: string, _fieldText: string) => {})
  const clearPendingLiveInputCommit = vi.fn(() => {})
  const flushPendingLiveInputText = vi.fn(async (_expectedHandle: string | null) => flushResult)
  const waitForPendingLiveInputFlush = vi.fn(async () => waitResult)
  const setLiveInputCapture = vi.fn((_text: string) => {})

  let commit: AccessoryInputCommitHarness['commit'] | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    commit = useTerminalLiveAccessoryInputCommit({
      activeHandle,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      heldLiveInputTextRef,
      liveInputRef,
      liveInputTerminalHandles,
      pendingLiveInputHandleRef,
      sentLiveInputTextRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture,
      waitForPendingLiveInputFlush
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
  if (!commit || !renderer) {
    throw new Error('terminal live accessory input hook did not render')
  }

  return {
    commit,
    sent,
    applyLiveInputMirror,
    flushPendingLiveInputText,
    waitForPendingLiveInputFlush,
    unmount: () => {
      act(() => renderer?.unmount())
    }
  }
}

describe('terminal live accessory inactive input commit result', () => {
  it('Given live input is disabled with an active flush When accessory raw fallback is requested Then waits before allowing raw send', async () => {
    // Given
    const deferredFlush = createDeferredBoolean()
    let settled = false

    // When
    const resultPromise = getTerminalLiveAccessoryInactiveInputCommitResult(
      () => deferredFlush.promise
    )
    void resultPromise.then(() => {
      settled = true
    })
    await Promise.resolve()

    // Then
    expect(settled).toBe(false)
    deferredFlush.resolve(true)
    await expect(resultPromise).resolves.toEqual({ kind: 'allow-raw' })
  })

  it('Given live input is disabled with a failed active flush When accessory raw fallback is requested Then suppresses raw send', async () => {
    // Given
    const waitForPendingLiveInputFlush = async (): Promise<boolean> => false

    // When
    const result = await getTerminalLiveAccessoryInactiveInputCommitResult(
      waitForPendingLiveInputFlush
    )

    // Then
    expect(result).toEqual({ kind: 'suppress-raw' })
  })
})

describe('terminal live accessory input commit hook', () => {
  it('Given raw accessory bytes with a held syllable When committed Then flushes held text before sending bytes', async () => {
    // Given
    const harness = createAccessoryInputCommitHarness({
      heldText: '한',
      sentText: '',
      pendingHandle: 'terminal-a'
    })

    // When
    const result = await harness.commit({ bytes: '\x1b' })

    // Then
    expect(harness.flushPendingLiveInputText).toHaveBeenCalledWith('terminal-a')
    expect(harness.sent).toEqual(['\x1b'])
    expect(result).toEqual({ kind: 'handled' })
  })

  it('Given raw accessory bytes with no held text When committed Then allows the raw send without flushing', async () => {
    // Given
    const harness = createAccessoryInputCommitHarness({ pendingHandle: null })

    // When
    const result = await harness.commit({ bytes: '\x1b' })

    // Then
    expect(result).toEqual({ kind: 'allow-raw' })
    expect(harness.flushPendingLiveInputText).not.toHaveBeenCalled()
    expect(harness.sent).toEqual([])
  })

  it('Given accessory backspace with a held syllable When committed Then mirrors the emptied field without terminal bytes', async () => {
    // Given
    const harness = createAccessoryInputCommitHarness({
      heldText: '한',
      sentText: '',
      pendingHandle: 'terminal-a'
    })

    // When
    const result = await harness.commit({ bytes: '\x7f', localEdit: 'backspace' })

    // Then
    expect(harness.applyLiveInputMirror).toHaveBeenCalledWith('terminal-a', '')
    expect(result).toEqual({ kind: 'handled' })
    expect(harness.sent).toEqual([])
  })

  it('Given accessory backspace with mirrored sent text When committed Then mirrors the shortened field so the diff emits DEL', async () => {
    // Given
    const harness = createAccessoryInputCommitHarness({
      heldText: '',
      sentText: 'ab',
      pendingHandle: 'terminal-a'
    })

    // When
    const result = await harness.commit({ bytes: '\x7f', localEdit: 'backspace' })

    // Then
    expect(harness.applyLiveInputMirror).toHaveBeenCalledWith('terminal-a', 'a')
    expect(result).toEqual({ kind: 'handled' })
  })
})
