import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostOs } from '../platform/host-os'
import { MobileSessionAccessoryKeys } from './MobileSessionAccessoryKeys'
import type { MobileSessionController } from './use-mobile-session-controller'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios },
    Pressable: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Pressable', props, children),
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  Keyboard: 'KeyboardIcon',
  Monitor: 'Monitor',
  Plus: 'Plus',
  Smartphone: 'Smartphone'
}))

vi.mock('../platform/host-os', () => ({
  hostOs: vi.fn(() => 'ios')
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

describe('MobileSessionAccessoryKeys keyboard dismiss button', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  function dismissButtons(instance: ReactTestRenderer) {
    return instance.root.findAll(
      (node) =>
        typeof node.type === 'string' && node.props?.accessibilityLabel === 'Dismiss keyboard'
    )
  }

  it('renders the dismiss keyboard button on iOS when the software keyboard is lifted', () => {
    vi.mocked(hostOs).mockReturnValue('ios')
    const dismissSoftwareKeyboard = vi.fn()
    act(() => {
      renderer = create(
        createElement(MobileSessionAccessoryKeys, {
          controller: createController({ keyboardLift: 280, dismissSoftwareKeyboard })
        })
      )
    })

    const [button] = dismissButtons(renderer!)
    expect(button).toBeDefined()
    act(() => button!.props.onPress())
    expect(dismissSoftwareKeyboard).toHaveBeenCalledOnce()
  })

  it('hides the redundant dismiss keyboard button on Android even when the software keyboard is lifted', () => {
    vi.mocked(hostOs).mockReturnValue('android')
    act(() => {
      renderer = create(
        createElement(MobileSessionAccessoryKeys, {
          controller: createController({ keyboardLift: 280 })
        })
      )
    })

    expect(dismissButtons(renderer!)).toHaveLength(0)
  })
})
