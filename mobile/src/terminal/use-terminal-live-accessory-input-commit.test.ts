import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
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

type AccessoryInputCommitHarnessOptions = {
  readonly composing?: boolean
  readonly heldText?: string
  readonly sentText?: string
  readonly pendingHandle?: string | null
  readonly waitResult?: boolean
}

type AccessoryInputCommitHarness = {
  readonly commit: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly applyLiveInputMirror: ReturnType<typeof vi.fn>
  readonly waitForPendingLiveInputFlush: ReturnType<typeof vi.fn>
  readonly unmount: () => void
}

function createAccessoryInputCommitHarness({
  composing,
  heldText = '',
  sentText = '',
  pendingHandle = null,
  waitResult = true
}: AccessoryInputCommitHarnessOptions = {}): AccessoryInputCommitHarness {
  const activeHandle = 'terminal-a'
  const heldLiveInputTextRef: RefObject<string> = { current: heldText }
  const liveInputComposingRef: RefObject<boolean | undefined> = { current: composing }
  const sentLiveInputTextRef: RefObject<string> = { current: sentText }
  const pendingLiveInputHandleRef: RefObject<string | null> = { current: pendingHandle }
  const liveInputRef: RefObject<TextInput | null> = { current: null }
  const liveInputTerminalHandles = new Set([activeHandle])
  const applyLiveInputMirror = vi.fn(
    async (_handle: string, _fieldText: string, _composing?: boolean) => true
  )
  const clearPendingLiveInputCommit = vi.fn(() => {})
  const endLiveInputSessionThenSend = vi.fn(async (_handle: string, _bytes: string) => true)
  const queueLiveInputControl = vi.fn(async (_handle: string, _bytes: string) => true)
  const waitForPendingLiveInputFlush = vi.fn(async () => waitResult)
  const setLiveInputCapture = vi.fn((_text: string) => {})

  let commit: AccessoryInputCommitHarness['commit'] | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    commit = useTerminalLiveAccessoryInputCommit({
      activeHandle,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      endLiveInputSessionThenSend,
      heldLiveInputTextRef,
      liveInputComposingRef,
      liveInputRef,
      liveInputTerminalHandles,
      onInteraction: vi.fn(),
      pendingLiveInputHandleRef,
      queueLiveInputControl,
      sentLiveInputTextRef,
      setLiveInputCapture,
      waitForPendingLiveInputFlush
    })
    return null
  }

  act(() => {
    renderer = create(createElement(Harness))
  })
  if (!commit || !renderer) {
    throw new Error('terminal live accessory input hook did not render')
  }

  return {
    commit,
    applyLiveInputMirror,
    waitForPendingLiveInputFlush,
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
    const waitForPendingLiveInputFlush = async (): Promise<boolean> => false

    const result = await getTerminalLiveAccessoryInactiveInputCommitResult(
      waitForPendingLiveInputFlush
    )

    expect(result).toEqual({ kind: 'suppress-raw' })
  })
})

describe('terminal live accessory input commit hook', () => {
  it('Given accessory backspace with reported composition When committed Then keeps the edited preedit held', async () => {
    const harness = createAccessoryInputCommitHarness({
      composing: true,
      heldText: 'ni hao',
      sentText: '',
      pendingHandle: 'terminal-a'
    })

    const result = await harness.commit({ bytes: '\x7f', localEdit: 'backspace' })

    expect(harness.applyLiveInputMirror).toHaveBeenCalledWith('terminal-a', 'ni ha', true)
    expect(result).toEqual({ kind: 'handled' })
  })

  it('Given accessory backspace with an unreported hold When committed Then preserves the Android fallback', async () => {
    const harness = createAccessoryInputCommitHarness({
      heldText: '한글',
      sentText: '',
      pendingHandle: 'terminal-a'
    })

    const result = await harness.commit({ bytes: '\x7f', localEdit: 'backspace' })

    expect(harness.applyLiveInputMirror).toHaveBeenCalledWith('terminal-a', '한', undefined)
    expect(result).toEqual({ kind: 'handled' })
  })

  it('Given accessory backspace with mirrored sent text When committed Then mirrors the shortened field so the diff emits DEL', async () => {
    const harness = createAccessoryInputCommitHarness({
      composing: false,
      heldText: '',
      sentText: 'ab',
      pendingHandle: 'terminal-a'
    })

    const result = await harness.commit({ bytes: '\x7f', localEdit: 'backspace' })

    expect(harness.applyLiveInputMirror).toHaveBeenCalledWith('terminal-a', 'a', false)
    expect(result).toEqual({ kind: 'handled' })
  })
})
