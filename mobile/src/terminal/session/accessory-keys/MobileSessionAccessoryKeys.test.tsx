import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_RAIL_KEY_IDS } from '../../key-input/terminal-accessory-layout'
import {
  MobileSessionAccessoryKeys,
  type MobileSessionAccessoryKeysController
} from './MobileSessionAccessoryKeys'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
  useColorScheme: () => 'dark',
  Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => {} }) }
}))
vi.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_, name) => String(name), has: () => true })
)
vi.mock('../../../platform/haptics/haptics', () => ({
  triggerMediumImpact: vi.fn()
}))
vi.mock('../../../platform/keyboard/keyboard-persisting-taps', () => ({
  useKeyboardPersistingTaps: () => ({ current: null })
}))

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

function makeController(
  overrides: Partial<{
    canPaste: boolean
    canSend: boolean
    chordBytes: string | null
  }> = {}
) {
  const sent: Array<{ bytes: string }> = []
  const handlePaste = vi.fn().mockResolvedValue(undefined)
  const takeModifiers = vi.fn(() => ({
    ctrl: 'off' as const,
    alt: 'off' as const,
    shift: 'off' as const
  }))
  const controller: MobileSessionAccessoryKeysController = {
    customKeys: [],
    setDeleteKeyTarget: vi.fn(),
    canPaste: overrides.canPaste ?? true,
    canSend: overrides.canSend ?? true,
    handleAccessoryKey: vi.fn().mockResolvedValue(true),
    stopAccessoryRepeat: vi.fn(),
    cancelAccessoryRepeat: vi.fn(),
    prepareAccessoryPress: vi.fn((input: { bytes: string }) => ({
      tap: vi.fn(() => {
        sent.push(input)
        return Promise.resolve(true)
      }),
      hold: vi.fn()
    })),
    handlePaste,
    dockKeys: {
      modifiers: { ctrl: 'off', alt: 'off', shift: 'off' },
      tapModifier: vi.fn(),
      takeModifiers,
      chordInput: vi.fn(() => (overrides.chordBytes ? { bytes: overrides.chordBytes } : null)),
      sendKey: vi.fn(),
      interceptTypedCharacter: vi.fn(() => false)
    },
    activeSessionTab: null,
    activeHandleRef: { current: 'term-1' },
    terminals: [],
    smartRailEnabled: false
  }
  return { controller, sent, handlePaste, takeModifiers }
}

const pressEvent = () => ({ type: 'press', nativeEvent: {} })

function directChildrenOf(node: ReactTestInstance): ReactTestInstance[] {
  return node.children.filter((child): child is ReactTestInstance => typeof child !== 'string')
}

describe('MobileSessionAccessoryKeys', () => {
  it('pins Paste and Enter outside the ScrollView beside More keys when clipboard has content', () => {
    const { controller, sent, handlePaste } = makeController({ canPaste: true })
    const onMoreKeys = vi.fn()
    act(() => {
      tree = create(createElement(MobileSessionAccessoryKeys, { controller, onMoreKeys }))
    })

    const keyRow = tree!.root.find((node) => String(node.type) === 'View')
    const rowChildren = directChildrenOf(keyRow)
    const scrollIndex = rowChildren.findIndex((child) => String(child.type) === 'ScrollView')
    expect(scrollIndex).toBe(0)

    const pinned = rowChildren.slice(1)
    expect(pinned.map((node) => node.props.accessibilityLabel)).toEqual([
      'Paste from clipboard',
      'Enter',
      'More keys and actions'
    ])

    act(() => {
      pinned[0]!.props.onPressIn(pressEvent())
      pinned[0]!.props.onPress(pressEvent())
    })
    expect(handlePaste).toHaveBeenCalledTimes(1)

    act(() => {
      pinned[1]!.props.onPressIn(pressEvent())
      pinned[1]!.props.onPress(pressEvent())
    })
    expect(sent).toEqual([{ bytes: '\r' }])
  })

  it('keeps Enter pinned when canPaste is false and composes with held modifiers', () => {
    const { controller, sent, takeModifiers } = makeController({
      canPaste: false,
      chordBytes: '\x1b[13;5u'
    })
    act(() => {
      tree = create(createElement(MobileSessionAccessoryKeys, { controller, onMoreKeys: vi.fn() }))
    })

    const keyRow = tree!.root.find((node) => String(node.type) === 'View')
    const rowChildren = directChildrenOf(keyRow)
    const pinned = rowChildren.slice(1)
    expect(pinned.map((node) => node.props.accessibilityLabel)).toEqual([
      'Enter',
      'More keys and actions'
    ])

    act(() => {
      pinned[0]!.props.onPressIn(pressEvent())
      pinned[0]!.props.onPress(pressEvent())
    })
    expect(takeModifiers).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ bytes: '\x1b[13;5u' }])
    expect(TERMINAL_RAIL_KEY_IDS.has('enter')).toBe(true)
  })
})
