import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalLiveInputFocusTarget,
  TerminalLiveInputFocusTimerRef
} from './terminal-live-input'
import { useTerminalLiveInputFocus } from './use-terminal-live-input-focus'

type HarnessProps = {
  readonly activeHandleRef: RefObject<string | null>
  readonly canSend: boolean
  readonly inputRef: RefObject<TerminalLiveInputFocusTarget | null>
  readonly keyboardHeight?: number
  readonly lifecycleIdentity: object | null
  readonly lifecycleKey: string
  readonly liveInputEnabled: boolean
  readonly timerRef: TerminalLiveInputFocusTimerRef
}

type FocusHandlers = ReturnType<typeof useTerminalLiveInputFocus>

function createFocusTarget(initiallyFocused = false): TerminalLiveInputFocusTarget & {
  readonly blur: ReturnType<typeof vi.fn>
  readonly focus: ReturnType<typeof vi.fn>
} {
  let focused = initiallyFocused
  return {
    blur: vi.fn(() => {
      focused = false
    }),
    focus: vi.fn(() => {
      focused = true
    }),
    isFocused: () => focused
  }
}

function createTimerRef(): TerminalLiveInputFocusTimerRef {
  return { current: null }
}

function createHarness(initialProps: HarnessProps): {
  readonly handlers: () => FocusHandlers
  readonly render: (props: HarnessProps) => void
  readonly unmount: () => void
} {
  let handlers: FocusHandlers | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(props: HarnessProps): null {
    handlers = useTerminalLiveInputFocus({
      ...props,
      keyboardHeight: props.keyboardHeight ?? 0
    })
    return null
  }

  act(() => {
    renderer = create(createElement(Harness, initialProps))
  })
  if (!handlers || !renderer) {
    throw new Error('terminal live input focus harness did not render')
  }

  return {
    handlers: () => {
      if (!handlers) {
        throw new Error('terminal live input focus harness is not mounted')
      }
      return handlers
    },
    render: (props) => {
      act(() => renderer?.update(createElement(Harness, props)))
    },
    unmount: () => {
      act(() => renderer?.unmount())
      handlers = null
    }
  }
}

function connectedProps(
  inputRef: RefObject<TerminalLiveInputFocusTarget | null>,
  timerRef = createTimerRef(),
  activeHandleRef: RefObject<string | null> = { current: 'terminal-a' }
): HarnessProps {
  return {
    activeHandleRef,
    canSend: true,
    inputRef,
    lifecycleIdentity: null,
    lifecycleKey: 'host-a:worktree-a:connected',
    liveInputEnabled: true,
    timerRef
  }
}

describe('terminal live input focus hook', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defers initial terminal surface focus until the WebView touch has completed', () => {
    vi.useFakeTimers()
    const input = createFocusTarget()
    const harness = createHarness(connectedProps({ current: input }))

    harness.handlers().handleTerminalTap('terminal-a')
    expect(input.focus).not.toHaveBeenCalled()

    vi.runOnlyPendingTimers()
    expect(input.focus).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('reacquires focus for mouse-aware and non-mouse terminal tap notifications', () => {
    vi.useFakeTimers()
    const input = createFocusTarget()
    const harness = createHarness(connectedProps({ current: input }))

    harness.handlers().handleTerminalTap('terminal-a')
    vi.runOnlyPendingTimers()
    harness.handlers().handleTerminalTap('terminal-a')
    vi.runAllTimers()

    expect(input.blur).toHaveBeenCalledTimes(1)
    expect(input.focus).toHaveBeenCalledTimes(2)
    harness.unmount()
  })

  it('cancels focus when navigation reuses the mounted route', () => {
    vi.useFakeTimers()
    const oldInput = createFocusTarget()
    const inputRef: RefObject<TerminalLiveInputFocusTarget | null> = { current: oldInput }
    const timerRef = createTimerRef()
    const harness = createHarness(connectedProps(inputRef, timerRef))
    harness.handlers().handleTerminalTap('terminal-a')
    const newInput = createFocusTarget()
    inputRef.current = newInput
    harness.render({
      ...connectedProps(inputRef, timerRef),
      lifecycleKey: 'host-a:worktree-b:connected'
    })
    vi.runOnlyPendingTimers()
    expect(oldInput.focus).not.toHaveBeenCalled()
    expect(newInput.focus).not.toHaveBeenCalled()

    harness.handlers().handleTerminalTap('terminal-a')
    vi.runOnlyPendingTimers()
    expect(newInput.focus).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('drops pending focus when reconnect reuses the mounted route', () => {
    vi.useFakeTimers()
    const oldInput = createFocusTarget()
    const oldInputRef = { current: oldInput }
    const timerRef = createTimerRef()
    const harness = createHarness(connectedProps(oldInputRef, timerRef))
    harness.handlers().handleTerminalTap('terminal-a')
    harness.render({
      ...connectedProps(oldInputRef, timerRef),
      canSend: false,
      lifecycleIdentity: {},
      lifecycleKey: 'host-a:worktree-a:disconnected'
    })
    vi.runOnlyPendingTimers()
    expect(oldInput.focus).not.toHaveBeenCalled()

    const replacementInput = createFocusTarget()
    oldInputRef.current = replacementInput
    harness.render({
      ...connectedProps(oldInputRef, timerRef),
      lifecycleIdentity: {},
      lifecycleKey: 'host-a:worktree-a:connected'
    })
    harness.handlers().handleTerminalTap('terminal-a')
    vi.runOnlyPendingTimers()
    expect(replacementInput.focus).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('cancels focus when a retained screen blurs', () => {
    vi.useFakeTimers()
    const input = createFocusTarget()
    const timerRef = createTimerRef()
    const harness = createHarness(connectedProps({ current: input }, timerRef))

    harness.handlers().handleTerminalTap('terminal-a')
    harness.handlers().resetLiveInputFocus()
    vi.runOnlyPendingTimers()

    expect(timerRef.current).toBeNull()
    expect(input.blur).toHaveBeenCalledTimes(1)
    expect(input.focus).not.toHaveBeenCalled()
    harness.unmount()
  })

  it('does not let stale handle state focus a replacement terminal', () => {
    vi.useFakeTimers()
    const firstInput = createFocusTarget()
    const inputRef: RefObject<TerminalLiveInputFocusTarget | null> = { current: firstInput }
    const timerRef = createTimerRef()
    const activeHandleRef = { current: 'terminal-a' as string | null }
    const harness = createHarness(connectedProps(inputRef, timerRef, activeHandleRef))
    harness.handlers().handleTerminalTap('terminal-a')

    const replacementInput = createFocusTarget()
    inputRef.current = replacementInput
    activeHandleRef.current = 'terminal-b'
    harness.render(connectedProps(inputRef, timerRef, activeHandleRef))
    vi.runOnlyPendingTimers()

    expect(firstInput.focus).not.toHaveBeenCalled()
    expect(replacementInput.focus).not.toHaveBeenCalled()
    harness.handlers().handleTerminalTap('terminal-b')
    vi.runOnlyPendingTimers()
    expect(replacementInput.focus).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('keeps the native focus target immediate outside the WebView tap path', () => {
    const input = createFocusTarget()
    const harness = createHarness(connectedProps({ current: input }))

    harness.handlers().focusLiveInput()

    expect(input.focus).toHaveBeenCalledTimes(1)
    harness.unmount()
  })
})
