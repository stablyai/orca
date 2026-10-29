import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveInputSelection } from './terminal-live-text-commit'
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
  readonly fieldText?: string
  readonly selection?: TerminalLiveInputSelection
}

type AccessoryInputCommitHarness = {
  readonly commit: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly applyLiveInputMirror: ReturnType<typeof vi.fn>
  readonly queueLiveInputControl: ReturnType<typeof vi.fn>
  readonly waitForPendingLiveInputFlush: ReturnType<typeof vi.fn>
  readonly setLiveInputCapture: ReturnType<typeof vi.fn>
  readonly setFieldValue: (value: string) => void
  readonly unmount: () => void
}

/** Separates native selection from mirrored text so accessory edits can exercise either state. */
function createAccessoryInputCommitHarness({
  composing,
  heldText = '',
  sentText = '',
  pendingHandle = null,
  waitResult = true,
  fieldText,
  selection
}: AccessoryInputCommitHarnessOptions = {}): AccessoryInputCommitHarness {
  const activeHandle = 'terminal-a'
  const heldLiveInputTextRef: RefObject<string> = { current: heldText }
  const liveInputComposingRef: RefObject<boolean | undefined> = { current: composing }
  const sentLiveInputTextRef: RefObject<string> = { current: sentText }
  const pendingLiveInputHandleRef: RefObject<string | null> = { current: pendingHandle }
  const liveInputTextRef: RefObject<string> = { current: fieldText ?? sentText + heldText }
  // An RN-Web ref is the DOM field; without a selection the ref stands in for a native field.
  // Node tests resolve the native text writer, so the field also takes its two calls.
  const webField = selection
    ? {
        value: liveInputTextRef.current,
        selectionStart: selection.start,
        selectionEnd: selection.end,
        setNativeProps: vi.fn(),
        setSelection: vi.fn()
      }
    : null
  const liveInputRef = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RN-Web hands the hook the DOM input as its TextInput ref; this models its caret fields.
    current: webField as unknown as TextInput | null
  }
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

  /** Mounts the real hook in React so callback dependencies follow the production lifecycle. */
  function Harness(): null {
    commit = useTerminalLiveAccessoryInputCommit({
      activeHandle,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      endLiveInputSessionThenSend,
      heldLiveInputTextRef,
      liveInputComposingRef,
      liveInputRef,
      liveInputTextRef,
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
    queueLiveInputControl,
    waitForPendingLiveInputFlush,
    setLiveInputCapture,
    setFieldValue: (value: string) => {
      if (webField) {
        webField.value = value
      }
    },
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

  it.each([
    ['backspace', { start: 2, end: 2 }, '可你好'],
    ['delete', { start: 2, end: 2 }, '可是好'],
    ['backspace', { start: 1, end: 3 }, '可好'],
    ['delete', { start: 1, end: 3 }, '可好']
  ] as const)(
    'edits %s at the native selection instead of the field end',
    async (localEdit, selection, expected) => {
      const harness = createAccessoryInputCommitHarness({
        composing: false,
        sentText: '可是你好',
        pendingHandle: 'terminal-a',
        selection
      })

      const result = await harness.commit({ bytes: '\x7f', localEdit })

      expect(harness.applyLiveInputMirror).toHaveBeenCalledWith('terminal-a', expected, false)
      expect(harness.queueLiveInputControl).not.toHaveBeenCalled()
      expect(result).toEqual({ kind: 'handled' })
      harness.unmount()
    }
  )

  it('suppresses accessory deletion while the field holds text the mirror has not seen', async () => {
    const harness = createAccessoryInputCommitHarness({
      composing: false,
      fieldText: 'abc',
      sentText: 'ab',
      pendingHandle: 'terminal-a',
      selection: { start: 1, end: 1 }
    })
    harness.setFieldValue('axbc')

    expect(await harness.commit({ bytes: '\x7f', localEdit: 'backspace' })).toEqual({
      kind: 'suppress-raw'
    })
    expect(harness.applyLiveInputMirror).not.toHaveBeenCalled()
    harness.unmount()
  })

  it('keeps raw smart punctuation in the field and normalizes only the mirror', async () => {
    const harness = createAccessoryInputCommitHarness({
      composing: false,
      fieldText: 'a—b',
      sentText: 'a--b',
      pendingHandle: 'terminal-a',
      selection: { start: 0, end: 0 }
    })

    await harness.commit({ bytes: '\x1b[3~', localEdit: 'delete' })

    expect(harness.setLiveInputCapture).toHaveBeenCalledWith('—b')
    expect(harness.applyLiveInputMirror).toHaveBeenCalledWith('terminal-a', '--b', false)
    harness.unmount()
  })
})
