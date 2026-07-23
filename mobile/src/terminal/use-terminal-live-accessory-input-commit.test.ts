import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveQueueControlOptions } from './use-terminal-live-pending-input-flush'
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
  readonly waitResult?: boolean
}

type AccessoryInputCommitHarness = {
  readonly commit: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly queued: readonly {
    readonly bytes: string
    readonly options: TerminalLiveQueueControlOptions
  }[]
  readonly clearPendingLiveInputCommit: ReturnType<typeof vi.fn>
  readonly queueLiveInputControl: ReturnType<typeof vi.fn>
  readonly waitForPendingLiveInputFlush: ReturnType<typeof vi.fn>
  readonly applyLiveInputMirror: ReturnType<typeof vi.fn>
  readonly unmount: () => void
}

function createAccessoryInputCommitHarness({
  heldText = '',
  sentText = '',
  pendingHandle = null,
  waitResult = true
}: AccessoryInputCommitHarnessOptions = {}): AccessoryInputCommitHarness {
  const activeHandle = 'terminal-a'
  const heldLiveInputTextRef: RefObject<string> = { current: heldText }
  const sentLiveInputTextRef: RefObject<string> = { current: sentText }
  const pendingLiveInputHandleRef: RefObject<string | null> = { current: pendingHandle }
  const liveInputRef: RefObject<TextInput | null> = { current: null }
  const liveInputTerminalHandles = new Set([activeHandle])
  const queued: { bytes: string; options: TerminalLiveQueueControlOptions }[] = []
  const queueLiveInputControl = vi.fn(
    async (_handle: string, bytes: string, options: TerminalLiveQueueControlOptions) => {
      queued.push({ bytes, options })
      return true
    }
  )
  const applyLiveInputMirror = vi.fn((_handle: string, _fieldText: string) => {})
  const clearPendingLiveInputCommit = vi.fn(() => {})
  const waitForPendingLiveInputFlush = vi.fn(async () => waitResult)
  const setLiveInputCapture = vi.fn((_text: string) => {})

  let commit: AccessoryInputCommitHarness['commit'] | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    commit = useTerminalLiveAccessoryInputCommit({
      activeHandle,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      heldLiveInputTextRef,
      liveInputRef,
      liveInputTerminalHandles,
      pendingLiveInputHandleRef,
      queueLiveInputControl,
      sentLiveInputTextRef,
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
    queued,
    clearPendingLiveInputCommit,
    queueLiveInputControl,
    waitForPendingLiveInputFlush,
    applyLiveInputMirror,
    unmount: () => {
      act(() => renderer?.unmount())
    }
  }
}

describe('terminal live accessory inactive input commit result', () => {
  it('Given live input is disabled with an active flush When accessory raw fallback is requested Then waits before allowing raw send', async () => {
    const deferredFlush = createDeferredBoolean()
    let settled = false
    const resultPromise = getTerminalLiveAccessoryInactiveInputCommitResult(
      () => deferredFlush.promise
    )
    void resultPromise.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    deferredFlush.resolve(true)
    await expect(resultPromise).resolves.toEqual({ kind: 'allow-raw' })
  })

  it('Given live input is disabled with a failed active flush When accessory raw fallback is requested Then suppresses raw send', async () => {
    const result = await getTerminalLiveAccessoryInactiveInputCommitResult(async () => false)
    expect(result).toEqual({ kind: 'suppress-raw' })
  })
})

describe('terminal live accessory input commit hook', () => {
  it('Given raw accessory with held syllable When committed Then queues commit-before-control and clears session sync', async () => {
    const harness = createAccessoryInputCommitHarness({
      heldText: '한',
      sentText: '',
      pendingHandle: 'terminal-a'
    })

    const result = await harness.commit({ bytes: '\x1b' })

    expect(harness.queueLiveInputControl).toHaveBeenCalledWith('terminal-a', '\x1b', {
      commitFieldBeforeControl: true
    })
    expect(harness.clearPendingLiveInputCommit).toHaveBeenCalledOnce()
    expect(result).toEqual({ kind: 'handled' })
  })

  it('Given raw accessory with sent-only field When committed Then queues control without commit prefix and clears sync', async () => {
    const harness = createAccessoryInputCommitHarness({
      heldText: '',
      sentText: 'abc',
      pendingHandle: 'terminal-a'
    })

    const result = await harness.commit({ bytes: '\x1b[D' })

    expect(harness.queueLiveInputControl).toHaveBeenCalledWith('terminal-a', '\x1b[D', {
      commitFieldBeforeControl: false
    })
    expect(harness.clearPendingLiveInputCommit).toHaveBeenCalledOnce()
    expect(result).toEqual({ kind: 'handled' })
  })

  it('Given raw accessory with no field session When committed Then allows the raw send without queueing', async () => {
    const harness = createAccessoryInputCommitHarness({ pendingHandle: null })

    const result = await harness.commit({ bytes: '\x1b' })

    expect(result).toEqual({ kind: 'allow-raw' })
    expect(harness.queueLiveInputControl).not.toHaveBeenCalled()
    expect(harness.clearPendingLiveInputCommit).not.toHaveBeenCalled()
  })

  it('Given accessory backspace with a held syllable When committed Then mirrors the emptied field without terminal bytes', async () => {
    const harness = createAccessoryInputCommitHarness({
      heldText: '한',
      sentText: '',
      pendingHandle: 'terminal-a'
    })

    const result = await harness.commit({ bytes: '\x7f', localEdit: 'backspace' })

    expect(harness.applyLiveInputMirror).toHaveBeenCalledWith('terminal-a', '')
    expect(result).toEqual({ kind: 'handled' })
    expect(harness.queueLiveInputControl).not.toHaveBeenCalled()
  })

  it('Given accessory backspace with mirrored sent text When committed Then mirrors the shortened field so the diff emits DEL', async () => {
    const harness = createAccessoryInputCommitHarness({
      heldText: '',
      sentText: 'ab',
      pendingHandle: 'terminal-a'
    })

    const result = await harness.commit({ bytes: '\x7f', localEdit: 'backspace' })

    expect(harness.applyLiveInputMirror).toHaveBeenCalledWith('terminal-a', 'a')
    expect(result).toEqual({ kind: 'handled' })
  })
})
