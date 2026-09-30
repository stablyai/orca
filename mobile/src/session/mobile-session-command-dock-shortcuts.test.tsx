import { createElement, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomKey } from '../components/CustomKeyModal'
import type { TerminalAccessoryLayout } from '../terminal/terminal-accessory-layout'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

const callbacks = vi.hoisted(() => ({
  send: vi.fn(),
  startRepeat: vi.fn(),
  stopRepeat: vi.fn(),
  haptic: vi.fn()
}))

const { Pressable } = await vi.hoisted(async () => {
  const react = await import('react')
  return {
    Pressable: ({ children }: { children?: ReactNode }) =>
      react.createElement('button', null, children)
  }
})

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  Pressable,
  Platform: { OS: 'ios' },
  Animated: { Value: class {} }
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: () => null,
  ChevronDown: () => null,
  ChevronsRight: () => null,
  Keyboard: () => null,
  Monitor: () => null,
  Plus: () => null,
  Smartphone: () => null
}))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: callbacks.haptic }))
vi.mock('../platform/keyboard-persisting-taps', () => ({ useKeyboardPersistingTaps: () => null }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('./MobileTerminalLiveInputStatus', () => ({ MobileTerminalLiveInputStatus: () => null }))
vi.mock('./MobileTerminalInputActions', () => ({ MobileTerminalInputActions: () => null }))
vi.mock('./use-terminal-live-input-mode-preference', () => ({
  useTerminalLiveInputModePreference: () => ({})
}))
vi.mock('./use-initial-session-terminal-autocreate', () => ({
  useWorktreeSessionTabsLoaded: () => [true, () => {}]
}))

import { MobileSessionCommandDock } from './MobileSessionCommandDock'
import { useMobileSessionScreenState } from './use-mobile-session-screen-state'

const customKeys: CustomKey[] = [
  { id: 'escape', label: 'Deploy', bytes: 'deploy\r', enter: true },
  { id: 'search', label: 'Find', bytes: '\x12', enter: false }
]
const layout: TerminalAccessoryLayout = {
  orderedBuiltInIds: ['escape', 'tab', 'backspace'],
  visibleBuiltInIds: ['escape', 'backspace'],
  orderedIds: [
    'custom:escape',
    'builtin:escape',
    'builtin:tab',
    'custom:search',
    'builtin:backspace'
  ]
}
const rendered: {
  state: ReturnType<typeof useMobileSessionScreenState> | null
  tree: ReactTestRenderer | null
} = { state: null, tree: null }

function Harness({ canSend = true }: { canSend?: boolean }) {
  const state = useMobileSessionScreenState(
    mountFixture({
      worktreeId: 'workspace',
      hostId: 'host',
      initialCreateWarning: ''
    })
  )
  rendered.state = state
  return createElement(MobileSessionCommandDock, {
    controller: mountFixture<ComponentProps<typeof MobileSessionCommandDock>['controller']>({
      ...state,
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
      bufferedTerminalDraftState: { input: '', setInput: () => {} },
      activeHandle: 'terminal',
      keyboardLift: 300,
      canSend,
      canCompose: true,
      canPaste: true,
      handleAccessoryKey: callbacks.send,
      startAccessoryRepeat: callbacks.startRepeat,
      stopAccessoryRepeat: callbacks.stopRepeat,
      dictation: {},
      liveInputEnabled: false,
      showNativeChat: false
    })
  })
}

function buttons() {
  if (!rendered.tree) {
    throw new Error('Dock is not mounted')
  }
  return rendered.tree.root.findAllByType(Pressable)
}
function button(label: string) {
  const found = buttons().find((node) => node.props.accessibilityLabel === label)
  if (!found) {
    throw new Error(`Missing button: ${label}`)
  }
  return found
}
function labels() {
  return buttons().map((node) => node.props.accessibilityLabel)
}
function mount(canSend = true) {
  act(() => {
    rendered.tree = create(createElement(Harness, { canSend }))
  })
  act(() => {
    rendered.state?.setCustomKeys(customKeys)
    rendered.state?.setTerminalAccessoryLayout(layout)
  })
}

describe('mixed shortcuts in the terminal command dock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    act(() => {
      rendered.tree?.unmount()
    })
    rendered.tree = null
    rendered.state = null
  })

  it('renders customs before and between built-ins while hiding disabled built-ins', () => {
    mount()
    expect(labels()).toEqual([
      'Dismiss keyboard',
      'Switch to desktop mode',
      'Switch to live terminal input',
      'Paste from clipboard',
      'Send Deploy',
      'Escape',
      'Send Find',
      'Backspace',
      'Add custom shortcut',
      'Send command'
    ])
  })

  it('keeps custom bytes, built-in local edits and repeat handling distinct after reordering', () => {
    mount()
    act(() => {
      button('Send Deploy').props.onPress()
    })
    expect(callbacks.send).toHaveBeenLastCalledWith({ bytes: 'deploy\r' })
    act(() => {
      button('Escape').props.onPressIn()
      button('Escape').props.onPress()
      button('Escape').props.onPressOut()
    })
    expect(callbacks.send).toHaveBeenLastCalledWith({ bytes: '\x1b' })
    expect(callbacks.startRepeat).not.toHaveBeenCalled()
    expect(callbacks.stopRepeat).not.toHaveBeenCalled()
    act(() => {
      button('Backspace').props.onPressIn()
      button('Backspace').props.onPress()
      button('Backspace').props.onPressOut()
    })
    expect(callbacks.send).toHaveBeenCalledTimes(3)
    expect(callbacks.send).toHaveBeenLastCalledWith({ bytes: '\x7f', localEdit: 'backspace' })
    expect(callbacks.startRepeat).toHaveBeenCalledWith({ bytes: '\x7f', localEdit: 'backspace' })
    expect(callbacks.stopRepeat).toHaveBeenCalledOnce()
  })

  it('keeps long-press deletion and adding keys available in the mixed bar', () => {
    mount()
    expect(button('Send Deploy').props.delayLongPress).toBe(400)
    act(() => {
      button('Send Deploy').props.onLongPress()
    })
    expect(rendered.state?.deleteKeyTarget).toEqual(customKeys[0])
    expect(callbacks.haptic).toHaveBeenCalledOnce()
    act(() => {
      button('Add custom shortcut').props.onPress()
    })
    expect(rendered.state?.showCustomKeyModal).toBe(true)
  })

  it('updates labels and removes deleted custom keys without changing surviving positions', () => {
    mount()
    act(() => {
      rendered.state?.setCustomKeys([{ ...customKeys[0]!, label: 'Release', bytes: 'release\r' }])
    })
    expect(labels().slice(4, 8)).toEqual([
      'Send Release',
      'Escape',
      'Backspace',
      'Add custom shortcut'
    ])
    act(() => {
      button('Send Release').props.onPress()
    })
    expect(callbacks.send).toHaveBeenLastCalledWith({ bytes: 'release\r' })
  })

  it('disables both kinds of terminal input when disconnected', () => {
    mount(false)
    for (const label of ['Send Deploy', 'Escape', 'Send Find', 'Backspace']) {
      expect(button(label).props.disabled).toBe(true)
    }
    expect(button('Add custom shortcut').props.disabled).not.toBe(true)
  })
})
