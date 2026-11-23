import { createElement, useState, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { documentQueryClient } from '../../../../test-support/rpc-recording/react-mounting/hook-mount'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessibilityInfo, Platform } from 'react-native'

import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatPickerPresentation
} from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'

vi.mock('../../../../components/controls/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibilityWithOptions: vi.fn() },
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  FilePenLine: 'FilePenLine',
  Hand: 'Hand',
  LockKeyhole: 'LockKeyhole',
  Search: 'Search',
  ShieldAlert: 'ShieldAlert',
  ShieldCheck: 'ShieldCheck',
  X: 'X'
}))
vi.mock('../../../../components/bottom-drawer/BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
      visible ? React.createElement('BottomDrawer', { visible }, children) : null
  }
})

function findAllByHostType(root: ReactTestInstance, type: string) {
  return root.findAll((node) => node.type === type)
}

function findByHostType(root: ReactTestInstance, type: string) {
  return root.find((node) => node.type === type)
}

const MODEL_DESCRIPTOR: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: {
    type: 'select',
    currentValue: 'sonnet',
    choices: [
      { value: 'sonnet', label: 'Sonnet 5' },
      { value: 'opus', label: 'Opus 4.8', description: 'Most capable' }
    ]
  },
  valueSource: 'reported',
  transport: 'catalog',
  settable: true
}

describe('MobileNativeChatSessionOptionPickers', () => {
  let renderer: ReactTestRenderer | null = null
  let queries: ReturnType<typeof documentQueryClient>
  const setOption = vi.fn<MobileNativeChatSessionOptionsController['setOption']>()
  const invokeAction = vi.fn<MobileNativeChatSessionOptionsController['invokeAction']>()

  const mount = (
    snapshot: SessionOptionDescriptor[],
    isWorking = false,
    requestedPage: string | null = null,
    busy: { pendingId?: string; sendInFlight?: boolean } = {},
    optionSurface?: MobileNativeChatSessionOptionsController['optionSurface']
  ) => {
    const controller: MobileNativeChatSessionOptionsController = {
      ...(optionSurface ? { optionSurface } : {}),
      snapshot,
      pendingId: busy.pendingId ?? null,
      setOption,
      invokeAction,
      recordCommand: vi.fn()
    }
    function Pickers({ working }: { working: boolean }) {
      const [presentation, setPresentation] = useState<MobileNativeChatPickerPresentation | null>(
        requestedPage ? { page: requestedPage, refocus: false } : null
      )
      return createElement(MobileNativeChatSessionOptionPickers, {
        controller,
        isWorking: working,
        sendInFlight: busy.sendInFlight,
        presentation,
        onDrawerOpen: (page) => setPresentation({ page, refocus: false }),
        onNavigate: (page) => setPresentation((current) => current && { ...current, page })
      })
    }
    act(() => {
      queries = documentQueryClient()
      renderer = create(queries.wrap(createElement(Pickers, { working: isWorking })))
    })
  }

  const rowByText = (text: string) => {
    const label = findAllByHostType(findByHostType(renderer!.root, 'BottomDrawer'), 'Text').find(
      (node) => node.props.children === text
    )
    if (!label) {
      throw new Error(`No row labeled ${text}`)
    }
    let parent = label.parent
    while (parent && String(parent.type) !== 'Pressable') {
      parent = parent.parent
    }
    if (!parent) {
      throw new Error(`No pressable row for ${text}`)
    }
    return parent
  }

  beforeEach(() => {
    Platform.OS = 'ios'
    vi.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear()
    setOption.mockReset()
    setOption.mockResolvedValue(true)
    invokeAction.mockReset()
    invokeAction.mockResolvedValue(true)
  })
  afterEach(async () => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
    await queries?.end()
  })

  it('names Default as unreported until the host reports its model', async () => {
    const resetOption = vi.fn(async () => ({ snapshot: [] }))
    const surface = {
      getSnapshot: () => [],
      subscribe: () => () => {},
      setOption: async () => ({ snapshot: [] }),
      invokeAction: async () => ({ snapshot: [] }),
      resetOption
    }
    mount(
      [{ ...MODEL_DESCRIPTOR, defaultChoice: { selected: false } }],
      false,
      'model',
      {},
      surface
    )
    await act(async () => rowByText('Default').props.onPress())
    expect(resetOption).toHaveBeenCalledExactlyOnceWith('model')
    expect(
      findAllByHostType(renderer!.root, 'Text').some(
        (node) => node.props.children === 'Default model not reported'
      )
    ).toBe(true)
  })
})
