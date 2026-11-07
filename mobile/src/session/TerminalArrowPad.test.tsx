import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSessionAccessoryKeys } from './MobileSessionAccessoryKeys'
import { TerminalArrowPad } from './TerminalArrowPad'
import { useTerminalDockKeys } from './use-terminal-dock-keys'
import type { MobileSessionController } from './use-mobile-session-controller'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios },
    Pressable: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Pressable', props, children),
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1,
      absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }
    },
    Text: 'Text',
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children)
  }
})

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  ChevronUp: 'ChevronUp',
  Keyboard: 'KeyboardIcon',
  Monitor: 'Monitor',
  Plus: 'Plus',
  Smartphone: 'Smartphone'
}))

vi.mock('../layout/use-shell-side-rail', () => ({
  useDirectionPadAvailable: () => false
}))

function createController(
  overrides: Partial<MobileSessionController> = {}
): MobileSessionController {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: MobileSessionAccessoryKeys only reads the supplied accessory-row controller slice.
  return {
    activeHandle: 'term-1',
    customKeys: [],
    setShowCustomKeyModal: vi.fn(),
    setDeleteKeyTarget: vi.fn(),
    directionPadEnabled: true,
    visibleBuiltInIds: [],
    visibleBuiltInAccessoryKeys: [],
    terminalModes: new Map(),
    canPaste: false,
    canSend: true,
    toggleDisplayMode: vi.fn(async () => {}),
    handleAccessoryKey: vi.fn(async () => true),
    dismissSoftwareKeyboard: vi.fn(),
    stopAccessoryRepeat: vi.fn(),
    cancelAccessoryRepeat: vi.fn(),
    prepareAccessoryPress: vi.fn(() => ({
      tap: async () => true,
      hold: () => {}
    })),
    handlePaste: vi.fn(async () => {}),
    keyboardLift: 0,
    ...overrides
  } as unknown as MobileSessionController
}

describe('TerminalArrowPad', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  it('taps a quadrant and repeats when dragged past the threshold', () => {
    const onPressStart = vi.fn()
    const onTap = vi.fn()
    const onRepeatStart = vi.fn()
    const onRepeatStop = vi.fn()
    const onHoldChange = vi.fn()
    const onAccessibilityArrow = vi.fn()

    act(() => {
      renderer = create(
        createElement(TerminalArrowPad, {
          disabled: false,
          onPressStart,
          onTap,
          onRepeatStart,
          onRepeatStop,
          onHoldChange,
          onAccessibilityArrow
        })
      )
    })

    const pad = renderer!.root.find(
      (node) => typeof node.type === 'string' && node.props?.accessibilityRole === 'adjustable'
    )

    // Tap the top side (width=66, height=32 -> center=33,16; top=33,2)
    act(() => {
      pad.props.onResponderGrant({
        nativeEvent: { pageX: 100, pageY: 200, locationX: 33, locationY: 2 }
      })
    })
    expect(onPressStart).toHaveBeenCalledWith('arrowUp')
    expect(onHoldChange).toHaveBeenLastCalledWith(true)

    act(() => {
      pad.props.onResponderRelease({})
    })
    expect(onTap).toHaveBeenCalledOnce()
    expect(onRepeatStop).not.toHaveBeenCalled()
    expect(onHoldChange).toHaveBeenLastCalledWith(false)

    // Hold and drag right, then down, then release
    act(() => {
      pad.props.onResponderGrant({
        nativeEvent: { pageX: 100, pageY: 200, locationX: 33, locationY: 16 }
      })
      pad.props.onResponderMove({
        nativeEvent: { pageX: 120, pageY: 200 }
      })
    })
    expect(onRepeatStart).toHaveBeenLastCalledWith('arrowRight')

    act(() => {
      pad.props.onResponderMove({
        nativeEvent: { pageX: 100, pageY: 225 }
      })
    })
    expect(onRepeatStart).toHaveBeenLastCalledWith('arrowDown')

    act(() => {
      pad.props.onResponderRelease({})
    })
    expect(onRepeatStop).toHaveBeenCalledOnce()
    expect(onTap).toHaveBeenCalledOnce()
  })

  it('renders inside MobileSessionAccessoryKeys and locks horizontal scroll while held', () => {
    const tap = vi.fn(async () => true)
    const hold = vi.fn()
    const prepareAccessoryPress = vi.fn(() => ({ tap, hold }))

    act(() => {
      renderer = create(
        createElement(MobileSessionAccessoryKeys, {
          controller: createController({ prepareAccessoryPress })
        })
      )
    })

    const pad = renderer!.root.find(
      (node) => typeof node.type === 'string' && node.props?.accessibilityLabel === 'Arrow keys'
    )
    const scrollView = renderer!.root.find(
      (node) => typeof node.type === 'string' && node.type === 'ScrollView'
    )
    expect(scrollView.props.scrollEnabled).toBe(true)

    act(() => {
      pad.props.onResponderGrant({
        nativeEvent: { pageX: 50, pageY: 50, locationX: 4, locationY: 16 }
      })
    })
    expect(prepareAccessoryPress).toHaveBeenCalledWith({ bytes: '\x1b[D' })
    expect(scrollView.props.scrollEnabled).toBe(false)

    act(() => {
      pad.props.onResponderRelease({})
    })
    expect(tap).toHaveBeenCalledOnce()
    expect(scrollView.props.scrollEnabled).toBe(true)
  })

  it('consumes held sticky modifiers from useTerminalDockKeys when tapping an arrow quadrant', () => {
    const tap = vi.fn(async () => true)
    const hold = vi.fn()
    const prepareAccessoryPress = vi.fn(() => ({ tap, hold }))

    function Harness() {
      const dockKeys = useTerminalDockKeys({
        activeHandle: 'term-1',
        sendInput: vi.fn(async () => true)
      })
      return createElement(MobileSessionAccessoryKeys, {
        controller: createController({ dockKeys, prepareAccessoryPress })
      })
    }

    act(() => {
      renderer = create(createElement(Harness))
    })

    const pad = renderer!.root.find(
      (node) => typeof node.type === 'string' && node.props?.accessibilityLabel === 'Arrow keys'
    )

    act(() => {
      pad.props.onResponderGrant({
        nativeEvent: { pageX: 50, pageY: 50, locationX: 4, locationY: 16 }
      })
    })
    expect(prepareAccessoryPress).toHaveBeenLastCalledWith({ bytes: '\x1b[D' })

    act(() => {
      pad.props.onResponderRelease({})
    })
    expect(tap).toHaveBeenCalledOnce()
  })
})
