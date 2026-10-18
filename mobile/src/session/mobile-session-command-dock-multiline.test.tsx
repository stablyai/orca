import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { addListener: () => ({ remove: () => {} }) },
  Platform: {
    OS: 'ios',
    select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    absoluteFillObject: {},
    create: (styles: unknown) => styles,
    hairlineWidth: 1
  },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'Icon',
  ChevronDown: 'Icon',
  ChevronsRight: 'Icon',
  ImagePlus: 'Icon',
  Keyboard: 'Icon',
  Mic: 'Icon',
  Monitor: 'Icon',
  Plus: 'Icon',
  Smartphone: 'Icon'
}))
vi.mock('expo-haptics', () => ({
  AndroidHaptics: {},
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {},
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  performAndroidHapticsAsync: vi.fn(),
  selectionAsync: vi.fn()
}))

import { MobileSessionCommandDock } from './MobileSessionCommandDock'
import type { MobileSessionController } from './use-mobile-session-controller'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Draft = { input: string }

function commandController(draft: Draft, sent: string[]): MobileSessionController {
  const noop = (): void => {}
  const scope = {
    insets: { bottom: 0 },
    bufferedTerminalDraftState: {
      input: draft.input,
      setInput: (next: string) => {
        draft.input = next
      }
    },
    autocompleteEnabled: false,
    liveInputCapture: '',
    activeHandle: 'terminal-1',
    customKeys: [],
    setShowCustomKeyModal: noop,
    setDeleteKeyTarget: noop,
    visibleBuiltInAccessoryKeys: [],
    terminalModes: new Map(),
    canPaste: false,
    dictationMode: 'toggle',
    bindCommandField: noop,
    handleLiveInputChange: noop,
    handleLiveInputKeyPress: noop,
    bindLiveInputField: noop,
    submitLiveInput: noop,
    canSend: true,
    canCompose: true,
    liveInputEnabled: false,
    focusLiveInput: noop,
    showNativeChat: false,
    dictation: { isStarting: false, isRecording: false, isProcessing: false },
    cancelDictation: noop,
    handleDictationToggle: noop,
    handleDictationPressIn: noop,
    handleDictationPressOut: noop,
    toggleDisplayMode: noop,
    handleSend: () => {
      sent.push(draft.input)
    },
    handleAccessoryKey: noop,
    dismissSoftwareKeyboard: noop,
    toggleLiveInput: noop,
    stopAccessoryRepeat: noop,
    startAccessoryRepeat: noop,
    handlePaste: noop,
    isAttaching: false,
    attachImage: noop,
    activeMarkdownTab: null,
    activeFileTab: null,
    activeBrowserTab: null,
    keyboardLift: 0
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buffered multiline render reads only these controller members.
  return scope as unknown as MobileSessionController
}

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

describe('multiline command input', () => {
  it('inserts a newline on return and sends the whole buffer from the send button', () => {
    const draft: Draft = { input: 'echo first' }
    const sent: string[] = []
    const buffer = 'echo first\necho second'

    act(() => {
      tree = create(
        createElement(MobileSessionCommandDock, { controller: commandController(draft, sent) })
      )
    })
    const field = () => tree?.root.findByProps({ placeholder: 'Type a command…' })

    act(() => {
      field()?.props.onChangeText(buffer)
    })
    expect(sent).toEqual([])

    act(() => {
      tree?.update(
        createElement(MobileSessionCommandDock, { controller: commandController(draft, sent) })
      )
    })
    expect(field()?.props.multiline).toBe(true)
    expect(field()?.props.submitBehavior).toBe('newline')
    expect(field()?.props.returnKeyType).toBe('default')
    expect(field()?.props.value).toBe(buffer)

    act(() => {
      tree?.root.findByProps({ accessibilityLabel: 'Send command' }).props.onPress()
    })
    expect(sent).toEqual([buffer])
  })
})
