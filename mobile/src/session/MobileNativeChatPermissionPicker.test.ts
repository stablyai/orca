import { createElement } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { colors } from '../theme/mobile-theme'
import {
  MobileNativeChatPermissionPicker,
  type MobileNativeChatPermissionPickerState
} from './MobileNativeChatPermissionPicker'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  X: 'X'
}))
vi.mock('../components/BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children?: React.ReactNode }) =>
      visible ? React.createElement('BottomDrawer', { visible }, children) : null
  }
})

let renderer: ReactTestRenderer | null = null

/** The mocked host components render as their names, which the instance types cannot express. */
function isHost(node: ReactTestInstance, name: string): boolean {
  const type: unknown = node.type
  return type === name
}

function mount(
  overrides: Partial<MobileNativeChatPermissionPickerState> = {},
  disabled = false
): MobileNativeChatPermissionPickerState {
  const picker: MobileNativeChatPermissionPickerState = {
    provider: 'claude',
    current: 'ask',
    supported: ['ask', 'accept-edits', 'auto', 'bypass'],
    pending: false,
    setMode: vi.fn(async () => true),
    ...overrides
  }
  act(() => {
    renderer = create(createElement(MobileNativeChatPermissionPicker, { picker, disabled }))
  })
  return picker
}

function pill(): ReactTestInstance {
  return renderer!.root.find(
    (node) =>
      isHost(node, 'Pressable') &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Permissions,')
  )
}

/** The last match: the pill repeats the current mode's name ahead of its drawer row. */
function textNode(text: string): ReactTestInstance {
  const found = renderer!.root
    .findAll((node) => isHost(node, 'Text'))
    .findLast((node) => node.props.children === text)
  if (!found) {
    throw new Error(`No text ${text}`)
  }
  return found
}

function row(text: string): ReactTestInstance {
  let parent = textNode(text).parent
  while (parent && !isHost(parent, 'Pressable')) {
    parent = parent.parent
  }
  if (!parent) {
    throw new Error(`No row for ${text}`)
  }
  return parent
}

function color(node: ReactTestInstance): string | undefined {
  let found: string | undefined
  for (const style of [node.props.style].flat(3)) {
    const value: unknown =
      style && typeof style === 'object' && 'color' in style ? style.color : null
    if (typeof value === 'string') {
      found = value
    }
  }
  return found
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('MobileNativeChatPermissionPicker', () => {
  it('names the current mode on its own pill', () => {
    mount({ current: 'auto' })
    expect(pill().props.accessibilityLabel).toBe('Permissions, Approve for me')
  })

  it('names retained Auto while withholding it as a new pick', () => {
    mount({ current: 'auto', supported: ['ask', 'bypass'] })
    expect(pill().props.accessibilityLabel).toBe('Permissions, Approve for me')
    act(() => pill().props.onPress())
    expect(
      renderer!.root.findAll(
        (node) => isHost(node, 'Pressable') && node.props.accessibilityLabel === 'Approve for me'
      )
    ).toHaveLength(0)
    expect(row('Ask for approval')).toBeTruthy()
  })

  it('lists the modes the agent offers with what each does', () => {
    mount({ supported: ['ask', 'auto', 'bypass'] })
    act(() => pill().props.onPress())

    expect(textNode('Ask for approval')).toBeTruthy()
    expect(textNode('Reviews approval requests for you')).toBeTruthy()
    expect(textNode("Asks before edits and commands your settings don't allow")).toBeTruthy()
    expect(() => textNode('Accept edits')).toThrow()
    expect(row('Ask for approval').props.accessibilityState).toMatchObject({ checked: true })
  })

  it('describes Codex approval at the workspace sandbox boundary', () => {
    mount({ provider: 'codex', supported: ['ask', 'auto', 'bypass'] })
    act(() => pill().props.onPress())
    expect(textNode('Works inside the workspace sandbox; asks before going beyond it')).toBeTruthy()
    expect(() => textNode("Asks before edits and commands your settings don't allow")).toThrow()
    expect(textNode('Never asks; no sandbox')).toBeTruthy()
  })

  it('keeps the drawer open when the write is unconfirmed', async () => {
    mount({ current: 'bypass', setMode: vi.fn(async () => false) })
    act(() => pill().props.onPress())
    await act(async () => row('Ask for approval').props.onPress())
    expect(row('Ask for approval').props.accessibilityState).toMatchObject({ checked: false })
    expect(row('Full access').props.accessibilityState).toMatchObject({ checked: true })
  })

  it('shows Full access in the warning colour on the pill and in the drawer', () => {
    mount({ current: 'bypass' })
    expect(color(pill().find((node) => isHost(node, 'Text')))).toBe(colors.statusAmber)

    act(() => pill().props.onPress())
    expect(color(textNode('Full access'))).toBe(colors.statusAmber)
    expect(color(textNode('Ask for approval'))).not.toBe(colors.statusAmber)
  })

  it('establishes Ask even when the displayed mode may be stale', async () => {
    const picker = mount({ current: 'ask' })
    act(() => pill().props.onPress())

    await act(async () => row('Ask for approval').props.onPress())
    expect(picker.setMode).toHaveBeenCalledWith('ask')

    act(() => pill().props.onPress())
    await act(async () => row('Full access').props.onPress())
    expect(picker.setMode).toHaveBeenCalledWith('bypass')
  })

  it('locks while a send or a pick is in flight', () => {
    mount({}, true)
    expect(pill().props.disabled).toBe(true)
    act(() => renderer?.unmount())
    mount({ pending: true })
    expect(pill().props.disabled).toBe(true)
  })
})
