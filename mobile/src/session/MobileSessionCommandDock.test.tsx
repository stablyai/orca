// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TextInput } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileSessionCommandDock } from './MobileSessionCommandDock'
import { useTerminalLiveInputFocus } from '../terminal/use-terminal-live-input-focus'

vi.mock('react-native', async () => {
  const React = await import('react')
  const View = (props: { children?: React.ReactNode; 'aria-hidden'?: boolean }) =>
    React.createElement('div', { 'aria-hidden': props['aria-hidden'] }, props.children)
  return {
    View,
    Pressable: View,
    TextInput: React.forwardRef(
      (props: { accessibilityLabel?: string; placeholder?: string; tabIndex?: number }, ref) => {
        const node = React.useRef<HTMLInputElement>(null)
        React.useImperativeHandle(ref, () => ({
          focus: () => node.current?.focus(),
          blur: () => node.current?.blur(),
          isFocused: () => document.activeElement === node.current
        }))
        return React.createElement('input', {
          ref: node,
          'aria-label': props.accessibilityLabel,
          placeholder: props.placeholder,
          tabIndex: props.tabIndex
        })
      }
    ),
    Platform: { OS: 'web', select: (values: { default: unknown }) => values.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('./MobileTerminalInputActions', () => ({
  MobileTerminalInputActions: () => null,
  MobileTerminalAttachButton: () => null,
  MobileTerminalDictationButton: () => null
}))
vi.mock('../components/composer-input/MessageBox', async () => {
  const React = await import('react')
  const { TextInput } = await import('react-native')
  const Input: React.ElementType = TextInput
  return {
    MessageBox: ({
      inputRef,
      placeholder,
      tabIndex
    }: {
      inputRef: React.Ref<unknown>
      placeholder?: string
      tabIndex?: number
    }) => React.createElement(Input, { ref: inputRef, placeholder, tabIndex })
  }
})
vi.mock('../components/composer-input/ComposerSendButton', () => ({
  ComposerSendButton: () => null
}))
vi.mock('./native-chat/input/MobileNativeChatStopButton', () => ({
  MobileNativeChatStopButton: () => null
}))
vi.mock('./MobileTerminalLiveInputStatus', () => ({ MobileTerminalLiveInputStatus: () => null }))
vi.mock('./MobileTerminalCommandDictationPreview', () => ({
  MobileTerminalCommandDictationPreview: () => null
}))
vi.mock('./MobileSessionAccessoryKeys', () => ({ MobileSessionAccessoryKeys: () => null }))
vi.mock('../platform/host-os', () => ({ hostOs: () => 'ios' }))

type Selection = { handle: string; liveInputEnabled: boolean }
let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.useRealTimers()
})

function Harness({ handle, liveInputEnabled }: Selection) {
  const liveInputRef = useRef<TextInput>(null)
  const commandInputRef = useRef<TextInput>(null)
  const activeHandleRef = useRef(handle)
  useLayoutEffect(() => {
    activeHandleRef.current = handle
  }, [handle])
  useTerminalLiveInputFocus({
    activeHandleRef,
    inputRef: liveInputRef,
    commandInputRef,
    canSend: true,
    keyboardHeight: 0,
    lifecycleIdentity: null,
    lifecycleKey: 'host:workspace:connected',
    liveInputEnabled,
    reopenFocusedInputWhenKeyboardHidden: false,
    timerRef: useRef(null)
  })
  const controller = {
    insets: { bottom: 0 },
    bufferedTerminalDraftState: { input: '', setInput: () => {} },
    liveInputCapture: '',
    liveInputEnabled,
    canSend: true,
    canCompose: true,
    dictation: { meter: null },
    commandFieldAnchorRef: { current: null },
    activeHandle: handle,
    activeSessionTab: null,
    dockKeys: { interceptTypedCharacter: () => false },
    keyboardLift: 0,
    liveInputRef,
    commandInputRef,
    bindLiveInputField: (field: TextInput | null) => {
      liveInputRef.current = field
    }
  }
  return createElement(MobileSessionCommandDock, {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real dock reads these fields; action children are inert and no send/dictation handler is invoked.
    controller: controller as unknown as Parameters<
      typeof MobileSessionCommandDock
    >[0]['controller'],
    keysInRail: true
  })
}

it.each(['terminal selection', 'preference hydration'] as const)(
  'keeps focus on the visible retained field after %s, leaving a closed keyboard alone',
  (transition) => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const render = (liveInputEnabled: boolean) =>
      act(() =>
        root?.render(
          createElement(Harness, {
            handle:
              liveInputEnabled && transition === 'terminal selection' ? 'terminal-b' : 'terminal-a',
            liveInputEnabled
          })
        )
      )
    render(false)
    const command = container.querySelector('input[placeholder="Write a command, then send"]')
    const live = container.querySelector('input[aria-label="Live terminal input"]')
    if (!(command instanceof HTMLInputElement) || !(live instanceof HTMLInputElement)) {
      throw new Error('Both dock fields must be mounted')
    }
    command.focus()

    render(true)
    expect(document.activeElement).toBe(live)
    expect(live.closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('false')
    render(false)
    expect(document.activeElement).toBe(command)
    expect(command.closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('false')
    expect(container.querySelector('input[aria-label="Live terminal input"]')).toBe(live)

    command.blur()
    render(true)
    render(false)
    expect(document.activeElement).toBe(document.body)
    expect(vi.getTimerCount()).toBe(0)
  }
)
