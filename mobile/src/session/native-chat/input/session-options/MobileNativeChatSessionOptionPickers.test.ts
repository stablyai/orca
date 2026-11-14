import { createElement, useState, type ReactNode } from 'react'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../../../../test-support/query-client-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessibilityInfo, Platform } from 'react-native'

import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatPickerPresentation
} from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import {
  findAllByHostType,
  findByHostType
} from '../../../../test-support/react-test-renderer-host-nodes'

vi.mock('../../../../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
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
  const setOption = vi.fn<MobileNativeChatSessionOptionsController['setOption']>()
  const invokeAction = vi.fn<MobileNativeChatSessionOptionsController['invokeAction']>()

  const mount = (
    snapshot: SessionOptionDescriptor[],
    isWorking = false,
    requestedPage: string | null = null,
    busy: { pendingId?: string; sendInFlight?: boolean } = {}
  ) => {
    const controller: MobileNativeChatSessionOptionsController = {
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
      renderer = createWithQueryClient(createElement(Pickers, { working: isWorking }))
    })
    return (working: boolean, nextSnapshot = snapshot): void => {
      controller.snapshot = nextSnapshot
      act(() => renderer!.update(createElement(Pickers, { working })))
    }
  }

  const pill = (name: string) =>
    renderer!.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith(name)
    )

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
  afterEach(() => {
    act(() => {
      renderer?.unmount()
    })
    renderer = null
  })

  it('consumes a refused page without replay, then permits a fresh open and permission pick', async () => {
    const placeholder: SessionOptionDescriptor = {
      ...MODEL_DESCRIPTOR,
      kind: { type: 'select', choices: [] },
      valueSource: 'unknown',
      transport: 'agent-session',
      settable: false
    }
    const update = mount([placeholder], true, 'model')
    expect(pill('Model').props.disabled).toBe(true)
    act(() => pill('Model').props.onPress())
    expect(findAllByHostType(renderer!.root, 'BottomDrawer')).toHaveLength(0)
    update(false, [placeholder, PERMISSION_DESCRIPTOR])
    expect(pill('Model').props.disabled).toBe(false)
    expect(findAllByHostType(renderer!.root, 'BottomDrawer')).toHaveLength(0)
    await act(async () => pill('Model').props.onPress())
    await act(async () => rowByText('Permissions').props.onPress())
    await act(async () => rowByText('Full access').props.onPress())
    expect(setOption).toHaveBeenCalledExactlyOnceWith('permissionMode', 'full-access')
  })
})

const PERMISSION_CHOICES: SessionOptionSelectChoice[] = [
  { value: 'ask', label: 'Ask for approval' },
  { value: 'full-access', label: 'Full access' }
]

const PERMISSION_DESCRIPTOR: SessionOptionDescriptor = {
  id: 'permissionMode',
  label: 'Permissions',
  category: 'mode',
  kind: { type: 'select', currentValue: 'ask', choices: PERMISSION_CHOICES },
  valueSource: 'applied',
  transport: 'agent-session',
  settable: true
}
