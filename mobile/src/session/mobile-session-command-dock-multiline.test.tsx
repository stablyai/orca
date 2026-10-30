import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
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
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import { styles } from './mobile-session-styles'
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
    visibleAccessoryRows: [],
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

function mount(controller: MobileSessionController): void {
  act(() => {
    tree = create(createElement(MobileSessionCommandDock, { controller }))
  })
}

function commandField(): ReactTestInstance {
  const field = tree?.root.findByProps({ placeholder: 'Type a command…' })
  if (!field) {
    throw new Error('command field missing')
  }
  return field
}

function hostChildren(node: ReactTestInstance): ReactTestInstance[] {
  return node.children.filter((child): child is ReactTestInstance => typeof child !== 'string')
}

function accessibilityLabels(node: ReactTestInstance): string[] {
  const labels: string[] = []
  const label = node.props.accessibilityLabel
  if (typeof label === 'string') {
    labels.push(label)
  }
  for (const child of hostChildren(node)) {
    labels.push(...accessibilityLabels(child))
  }
  return labels
}

function dockHierarchy(): string[] {
  const field = commandField()
  const bar = field.parent
  if (!bar) {
    throw new Error('input bar missing')
  }
  expect(bar.props.style).toBe(styles.inputBar)
  expect(bar.props.style).toMatchObject({ flexDirection: 'row', alignItems: 'flex-end' })
  expect(styles.textInput).toMatchObject({ flex: 1, maxHeight: 120 })
  expect(field.props.style).toEqual(expect.arrayContaining([styles.textInput]))
  const actions = tree?.root.findByType(MobileTerminalInputActions)
  expect(actions?.parent).toBe(bar)
  expect(actions?.props.buttonStyle).toBe(styles.dictationButton)
  expect(styles.dictationButton).toMatchObject({ width: 32, height: 32 })
  expect(accessibilityLabels(bar)).toEqual([
    'Attach a photo',
    'Start voice dictation',
    'Send command'
  ])
  return hostChildren(bar).map((child) => {
    if (typeof child.type === 'string') {
      return child.type
    }
    if (typeof child.type === 'function') {
      return child.type.name
    }
    return 'node'
  })
}

describe('multiline command input', () => {
  it('keeps image, mic, and send beside a single-line command', () => {
    const draft: Draft = { input: 'echo first' }
    mount(commandController(draft, []))
    const hierarchy = dockHierarchy()
    expect(commandField().props.value).toBe('echo first')

    act(() => {
      commandField().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 34 } } })
    })
    expect(dockHierarchy()).toEqual(hierarchy)
    expect(commandField().props.style).toEqual(expect.arrayContaining([{ height: 34 }]))
  })

  it('grows the field without moving the buttons or remounting the input bar', () => {
    const draft: Draft = { input: 'echo first' }
    mount(commandController(draft, []))
    const hierarchy = dockHierarchy()

    act(() => {
      commandField().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 48 } } })
    })
    expect(commandField().props.value).toBe('echo first')
    expect(dockHierarchy()).toEqual(hierarchy)
    expect(commandField().props.style).toEqual(expect.arrayContaining([{ height: 48 }]))
    expect(commandField().parent?.props.style).toBe(styles.inputBar)

    act(() => {
      commandField().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 34 } } })
    })
    expect(commandField().props.value).toBe('echo first')
    expect(dockHierarchy()).toEqual(hierarchy)
    expect(commandField().props.style).toEqual(expect.arrayContaining([{ height: 34 }]))
  })

  it('inserts a newline on return and sends the whole buffer from the send button', () => {
    const draft: Draft = { input: 'echo first' }
    const sent: string[] = []
    const buffer = 'echo first\necho second'

    mount(commandController(draft, sent))
    const hierarchy = dockHierarchy()
    const field = () => commandField()

    act(() => {
      field().props.onChangeText(buffer)
    })
    expect(sent).toEqual([])

    act(() => {
      tree?.update(
        createElement(MobileSessionCommandDock, { controller: commandController(draft, sent) })
      )
    })
    expect(dockHierarchy()).toEqual(hierarchy)
    expect(field().props.multiline).toBe(true)
    expect(field().props.numberOfLines).toBeUndefined()
    expect(field().props.submitBehavior).toBe('newline')
    expect(field().props.returnKeyType).toBe('default')
    expect(field().props.value).toBe(buffer)

    act(() => {
      field().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 60 } } })
    })
    expect(dockHierarchy()).toEqual(hierarchy)
    expect(field().props.style).toEqual(expect.arrayContaining([{ height: 60 }]))

    act(() => {
      field().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 180 } } })
    })
    expect(dockHierarchy()).toEqual(hierarchy)
    expect(field().props.style).toEqual(expect.arrayContaining([{ height: 120 }]))

    act(() => {
      tree?.root.findByProps({ accessibilityLabel: 'Send command' }).props.onPress()
    })
    expect(sent).toEqual([buffer])
    expect(commandField().props.value).toBe(buffer)
    expect(dockHierarchy()).toEqual(hierarchy)
  })

  it('defaults an empty command field to a single-line height', () => {
    const draft: Draft = { input: '' }
    mount(commandController(draft, []))
    expect(commandField().props.numberOfLines).toBeUndefined()
    expect(commandField().props.style).toEqual(expect.arrayContaining([{ height: 34 }]))
  })

  it('resets to a single-line height after a multiline draft is cleared', () => {
    const draft: Draft = { input: 'echo first' }
    const sent: string[] = []
    mount(commandController(draft, sent))

    act(() => {
      commandField().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 60 } } })
    })
    expect(commandField().props.style).toEqual(expect.arrayContaining([{ height: 60 }]))

    act(() => {
      commandField().props.onChangeText('')
    })
    act(() => {
      tree?.update(
        createElement(MobileSessionCommandDock, { controller: commandController(draft, sent) })
      )
    })
    expect(commandField().props.value).toBe('')
    expect(commandField().props.style).toEqual(expect.arrayContaining([{ height: 34 }]))
  })

  it('sets rows=1 on a web HTMLTextAreaElement and shrinks height when lines are deleted', () => {
    class MockTextArea {
      rows = 2
      style = { height: '' }
      scrollHeight = 30
      focus(): void {}
      blur(): void {}
    }
    const prevTextArea = Reflect.get(globalThis, 'HTMLTextAreaElement')
    Reflect.set(globalThis, 'HTMLTextAreaElement', MockTextArea)
    try {
      const textarea = new MockTextArea()
      const draft: Draft = { input: 'echo first\necho second' }
      const sent: string[] = []
      act(() => {
        tree = create(
          createElement(MobileSessionCommandDock, { controller: commandController(draft, sent) }),
          {
            createNodeMock: (element) => (element.type === 'TextInput' ? textarea : null)
          }
        )
      })
      expect(textarea.rows).toBe(1)

      textarea.scrollHeight = 54
      act(() => {
        commandField().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 54 } } })
      })
      expect(commandField().props.style).toEqual(expect.arrayContaining([{ height: 54 }]))

      textarea.scrollHeight = 30
      act(() => {
        commandField().props.onChangeText('echo first')
      })
      act(() => {
        tree?.update(
          createElement(MobileSessionCommandDock, { controller: commandController(draft, sent) })
        )
      })
      expect(textarea.style.height).toBe('34px')
      expect(commandField().props.style).toEqual(expect.arrayContaining([{ height: 34 }]))
    } finally {
      if (prevTextArea === undefined) {
        Reflect.deleteProperty(globalThis, 'HTMLTextAreaElement')
      } else {
        Reflect.set(globalThis, 'HTMLTextAreaElement', prevTextArea)
      }
    }
  })
})
