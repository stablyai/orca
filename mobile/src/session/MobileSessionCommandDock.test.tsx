import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { TextInput, Pressable } from 'react-native'
import { HardwareKeyboardCaptureView } from '@orca/expo-hardware-keyboard'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalLiveInputCommitHarness } from '../terminal/terminal-live-input-commit.test-support'
import { MobileSessionCommandDock } from './MobileSessionCommandDock'
import type { MobileSessionController } from './use-mobile-session-controller'

vi.mock('react-native', () => ({
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios', select: (options: { ios: unknown }) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('@orca/expo-hardware-keyboard', () => ({
  HardwareKeyboardCaptureView: 'HardwareKeyboardCaptureView'
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  ChevronsRight: 'ChevronsRight',
  Keyboard: 'Keyboard',
  Monitor: 'Monitor',
  Plus: 'Plus',
  Smartphone: 'Smartphone',
  ImagePlus: 'ImagePlus',
  Mic: 'Mic'
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('../platform/live-input-composing-range', () => ({
  reportedLiveInputComposing: (composing: boolean | undefined) => composing
}))

const unmounts: Array<() => void> = []

function mountDock({ canSend = true, liveInputEnabled = true } = {}) {
  const live = createTerminalLiveInputCommitHarness()
  const submit = vi.fn(() => void live.handlers.handleLiveInputSubmit())
  const focus = vi.fn()
  const bindLiveInputField = vi.fn()
  const handleSend = vi.fn()
  const controller = {
    insets: { bottom: 0 },
    bufferedTerminalDraftState: { input: '', setInput: vi.fn() },
    liveInputCapture: '',
    activeHandle: 'terminal-a',
    customKeys: [],
    visibleBuiltInAccessoryKeys: [],
    terminalModes: new Map(),
    canPaste: false,
    dictationMode: undefined,
    bindCommandField: vi.fn(),
    handleLiveInputChange: live.handlers.handleLiveInputChange,
    handleLiveInputHardwareKey: live.handlers.handleLiveInputHardwareKey,
    handleLiveInputKeyPress: live.handlers.handleLiveInputKeyPress,
    bindLiveInputField,
    submitLiveInput: submit,
    canSend,
    canCompose: true,
    liveInputEnabled,
    focusLiveInput: focus,
    showNativeChat: false,
    dictation: { isStarting: false, isRecording: false, isProcessing: false },
    handleSend,
    keyboardLift: 0
  }
  let renderer: ReactTestRenderer | null = null
  act(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every render-time field; tests invoke only the live input, focus, and submit callbacks defined above.
    renderer = create(
      createElement(MobileSessionCommandDock, {
        controller: controller as unknown as MobileSessionController
      })
    )
  })
  function getRenderer(): ReactTestRenderer {
    if (!renderer) {
      throw new Error('command dock did not mount')
    }
    return renderer
  }
  unmounts.push(() => {
    act(() => renderer?.unmount())
    live.unmount()
  })
  return { renderer: getRenderer(), live, submit, focus, bindLiveInputField, handleSend }
}

afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

describe('mobile terminal command dock input', () => {
  it('forwards marked text without sending preedit, then sends its committed candidate', async () => {
    const { renderer, live } = mountDock()
    const field = renderer.root.findByType(TextInput)
    field.props.onChange({ nativeEvent: { text: 'nihao', isComposing: true } })
    expect(live.captures.at(-1)).toBe('nihao')
    expect(live.sent).toEqual([])

    field.props.onChange({ nativeEvent: { text: '你好', isComposing: false } })
    await vi.waitFor(() => expect(live.sent.join('')).toBe('你好'))
  })

  it('connects the native capture view to the terminal byte sender', async () => {
    const { renderer, live } = mountDock()
    const capture = renderer.root.findByType(HardwareKeyboardCaptureView)
    expect(capture.props.enabled).toBe(true)
    capture.props.onHardwareKey({
      nativeEvent: {
        key: 'ArrowLeft',
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        repeat: false
      }
    })
    await vi.waitFor(() => expect(live.sent).toEqual(['\x1b[D']))
  })

  it('uses one submit callback without letting RN blur the live field', async () => {
    const { renderer, live, submit, bindLiveInputField } = mountDock()
    const field = renderer.root.findByType(TextInput)
    expect(field.props.ref).toBe(bindLiveInputField)
    expect(field.props.blurOnSubmit).toBe(false)
    expect(field.props.keyboardType).toBe('default')
    field.props.onSubmitEditing()
    expect(submit).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(live.sent).toEqual(['\r']))
  })

  it('keeps buffered Return on the existing send path without automatic blur', () => {
    const { renderer, handleSend } = mountDock({ liveInputEnabled: false })
    const field = renderer.root.findByType(TextInput)
    expect(field.props.blurOnSubmit).toBe(false)
    field.props.onSubmitEditing()
    expect(handleSend).toHaveBeenCalledOnce()
  })

  it('disables native capture and editing when the terminal cannot send', () => {
    const { renderer } = mountDock({ canSend: false })
    expect(renderer.root.findByType(HardwareKeyboardCaptureView).props.enabled).toBe(false)
    expect(renderer.root.findByType(TextInput).props.editable).toBe(false)
  })

  it('keeps the keyboard button on the existing focus path', () => {
    const { renderer, focus } = mountDock()
    const button = renderer.root
      .findAllByType(Pressable)
      .find((node) => node.props.accessibilityLabel === 'Show keyboard for live terminal input')
    expect(button).toBeDefined()
    button?.props.onPress()
    expect(focus).toHaveBeenCalledOnce()
  })

  it('does not silently change an unset dictation preference into toggle mode', () => {
    const { renderer } = mountDock()
    const microphone = renderer.root
      .findAllByType(Pressable)
      .find((node) => node.props.accessibilityLabel === 'Start voice dictation')
    expect(microphone).toBeDefined()
    expect(microphone?.props.onPress).toBeUndefined()
    expect(microphone?.props.onPressIn).toBeUndefined()
  })
})
