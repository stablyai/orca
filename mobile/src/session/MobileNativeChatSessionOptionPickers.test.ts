import { createElement, useState, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessibilityInfo, Platform } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { structuredAgentSessionPermissionDescriptor } from '../../../src/shared/structured-agent-session-permission-option'
import { createStructuredAgentSessionOptionState } from '../../../src/shared/structured-agent-session-options'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from '../../../src/shared/native-chat-session-options'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatPickerPresentation
} from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import { findAllByHostType, findByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibilityWithOptions: vi.fn() },
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
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
vi.mock('../components/BottomDrawer', async () => {
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

const EFFORT_DESCRIPTOR: SessionOptionDescriptor = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    currentValue: 'high',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
  },
  valueSource: 'dispatched',
  transport: 'catalog',
  settable: true
}

const FAST_MODE_DESCRIPTOR: SessionOptionDescriptor = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', currentValue: false },
  valueSource: 'reported',
  transport: 'catalog',
  settable: true
}

describe('MobileNativeChatSessionOptionPickers', () => {
  let renderer: ReactTestRenderer | null = null
  const setOption = vi.fn<MobileNativeChatSessionOptionsController['setOption']>()
  const invokeAction = vi.fn<MobileNativeChatSessionOptionsController['invokeAction']>()

  const mount = (snapshot: SessionOptionDescriptor[], isWorking = false) => {
    const controller: MobileNativeChatSessionOptionsController = {
      snapshot,
      pendingId: null,
      setOption,
      invokeAction,
      recordCommand: vi.fn()
    }
    function Pickers({ working }: { working: boolean }) {
      const [presentation, setPresentation] = useState<MobileNativeChatPickerPresentation | null>(
        null
      )
      return createElement(MobileNativeChatSessionOptionPickers, {
        controller,
        isWorking: working,
        presentation,
        onDrawerOpen: (page) => setPresentation({ page, refocus: false }),
        onNavigate: (page) => setPresentation((current) => current && { ...current, page })
      })
    }
    act(() => {
      renderer = create(createElement(Pickers, { working: isWorking }))
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

  it('renders nothing without a model descriptor', () => {
    mount([])
    expect(renderer!.toJSON()).toBeNull()
  })

  it('shows the current model and effort in one pill', () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    expect(pill('Model').props).toMatchObject({
      accessibilityLabel: 'Model, Sonnet 5 High',
      disabled: false
    })
  })

  it('lets the pill shrink so a long label never pushes the composer buttons off the row', () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    expect(findAllByHostType(renderer!.root, 'View')[0]!.props.style).toMatchObject({
      flexShrink: 1
    })
  })

  it('opens the model sheet and applies a picked model', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    expect(findByHostType(renderer!.root, 'BottomDrawer').props.visible).toBe(true)
    await act(async () => rowByText('Opus 4.8').props.onPress())
    expect(setOption).toHaveBeenCalledWith('model', 'opus')
  })

  it('picks effort in place on the model sheet', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    await act(async () => pill('Low').props.onPress())
    expect(setOption).toHaveBeenCalledWith('effort', 'low')
  })

  it('opens an option that is not effort on a page of its own from the model sheet', async () => {
    mount([MODEL_DESCRIPTOR, { ...EFFORT_DESCRIPTOR, category: 'model_config' }])
    await act(async () => pill('Model').props.onPress())
    await act(async () => rowByText('Effort').props.onPress())
    await act(async () => rowByText('Low').props.onPress())
    expect(setOption).toHaveBeenCalledWith('effort', 'low')
  })

  it('flips a yes-or-no option in place', async () => {
    mount([MODEL_DESCRIPTOR, FAST_MODE_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    const toggle = renderer!.root.findByProps({ accessibilityLabel: 'Fast mode' })
    await act(async () => toggle.props.onValueChange(true))
    expect(setOption).toHaveBeenCalledWith('fastMode', true)
  })

  it('announces choice selection and disabled state', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    expect(pill('Model').props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityState: { disabled: false }
    })
    await act(async () => pill('Model').props.onPress())
    expect(rowByText('Sonnet 5').props).toMatchObject({
      accessibilityRole: 'radio',
      accessibilityState: { checked: true, disabled: false }
    })
    expect(rowByText('Opus 4.8').props.accessibilityState?.checked).toBe(false)
  })

  it('does not dispatch when re-picking the tracked value', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    await act(async () => rowByText('Sonnet 5').props.onPress())
    expect(setOption).not.toHaveBeenCalled()
  })

  it('renders agent-picker descriptors as a single action row', async () => {
    mount([
      {
        ...MODEL_DESCRIPTOR,
        kind: { type: 'select', choices: [] },
        valueSource: 'unknown',
        transport: 'catalog',
        action: { type: 'agent-picker' }
      }
    ])
    await act(async () => pill('Model').props.onPress())
    expect(rowByText('Choose in agent picker…').props.accessibilityRole).toBe('button')
    await act(async () => rowByText('Choose in agent picker…').props.onPress())
    expect(invokeAction).toHaveBeenCalledWith('model')
  })

  // Terminal settings are inferred from screen parsing; structured settings are confirmed each turn and need no uncertainty caption.
  it.each([
    { transport: 'catalog' as const, caption: true },
    { transport: 'agent-session' as const, caption: false }
  ])('captions a dispatched value only on the terminal transport', async (scenario) => {
    mount([
      MODEL_DESCRIPTOR,
      { ...EFFORT_DESCRIPTOR, valueSource: 'dispatched', transport: scenario.transport }
    ])
    await act(async () => pill('Model').props.onPress())
    const captions = findAllByHostType(renderer!.root, 'Text').filter(
      (node) => node.props.children === 'Sent to the agent — not confirmed'
    )
    expect(captions.length > 0).toBe(scenario.caption)
  })

  it.each(['catalog', 'agent-session'] as const)(
    'does not caption a reported value on the %s transport',
    async (transport) => {
      mount([MODEL_DESCRIPTOR, { ...EFFORT_DESCRIPTOR, valueSource: 'reported', transport }])
      await act(async () => pill('Model').props.onPress())
      expect(
        findAllByHostType(renderer!.root, 'Text').some(
          (node) => node.props.children === 'Sent to the agent — not confirmed'
        )
      ).toBe(false)
    }
  )

  it('locks the model and effort while the agent works, but never the permission mode', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR, PERMISSION_DESCRIPTOR], true)
    expect(pill('Model').props).toMatchObject({ disabled: false })
    await act(async () => pill('Model').props.onPress())
    expect(rowByText('Opus 4.8').props.accessibilityState?.disabled).toBe(true)
    expect(pill('Low').props.accessibilityState?.disabled).toBe(true)
    expect(rowByText('Permissions').props.accessibilityState?.disabled).toBe(false)
    expect(renderer!.root.findByProps({ children: 'Agent is working' })).toBeDefined()
    await act(async () => rowByText('Permissions').props.onPress())
    expect(renderer!.root.findAllByProps({ children: 'Agent is working' })).toHaveLength(0)
  })

  it.each(['ios', 'android'] as const)(
    'announces the working notice without queuing only when it appears on %s',
    async (platform) => {
      Platform.OS = platform
      const updateWorking = mount([MODEL_DESCRIPTOR, PERMISSION_DESCRIPTOR])
      const announce = vi.mocked(AccessibilityInfo.announceForAccessibilityWithOptions)
      await act(async () => pill('Model').props.onPress())
      expect(announce).not.toHaveBeenCalled()

      updateWorking(true)
      const notice = renderer!.root.findByProps({ accessibilityLiveRegion: 'polite' })
      expect(notice.findByProps({ children: 'Agent is working' })).toBeDefined()
      if (platform === 'ios') {
        expect(announce).toHaveBeenCalledExactlyOnceWith(
          'Agent is working. Model settings unlock when this turn finishes.',
          { queue: false }
        )
      } else {
        expect(announce).not.toHaveBeenCalled()
      }

      updateWorking(true)
      updateWorking(false)
      await act(async () => rowByText('Permissions').props.onPress())
      updateWorking(true)
      expect(renderer!.root.findAllByProps({ children: 'Agent is working' })).toHaveLength(0)
      expect(announce).toHaveBeenCalledTimes(platform === 'ios' ? 1 : 0)

      await act(async () => pill('Back to models').props.onPress())
      expect(announce).toHaveBeenCalledTimes(platform === 'ios' ? 2 : 0)
      await act(async () => pill('Close picker').props.onPress())
      updateWorking(false)
      updateWorking(true)
      expect(announce).toHaveBeenCalledTimes(platform === 'ios' ? 2 : 0)
      await act(async () => pill('Model').props.onPress())
      expect(announce).toHaveBeenCalledTimes(platform === 'ios' ? 3 : 0)
    }
  )

  it('keeps the permission mode in the model sheet and warns on the pill at full access', async () => {
    mount([
      MODEL_DESCRIPTOR,
      {
        ...PERMISSION_DESCRIPTOR,
        kind: { type: 'select', currentValue: 'full-access', choices: PERMISSION_CHOICES }
      }
    ])
    expect(pill('Model').props.accessibilityLabel).toBe('Model, Sonnet 5, full access')
    setOption.mockImplementation(() => new Promise(() => {}))
    await act(async () => pill('Model').props.onPress())
    await act(async () => rowByText('Permissions').props.onPress())
    await act(async () => rowByText('Ask for approval').props.onPress())
    expect(setOption).toHaveBeenCalledWith('permissionMode', 'ask')
    expect(rowByText('Sonnet 5').props.accessibilityRole).toBe('radio')
  })

  it.each([
    ['claude', 'accept-edits', 'Accept edits'],
    ['codex', 'full-access', 'Full access'],
    ['claude', 'plan', 'Plan mode'],
    ['codex', 'read-only', 'Read only']
  ])('uses the nullable %s/%s report without an Own row', async (agent, mode, label) => {
    const state = createStructuredAgentSessionOptionState(agent, null)
    const snapshot = (reportedPermissionMode?: string | null) => {
      const row = structuredAgentSessionPermissionDescriptor({
        ...state,
        permissionMode: 'own',
        permissionOwnSupported: true,
        reportedPermissionMode
      })
      return row ? [row] : []
    }
    const update = mount(snapshot())
    expect(pill('Permissions').props).toMatchObject({
      disabled: true,
      accessibilityLabel: 'Permissions, Permissions'
    })
    for (const report of [mode, null, mode, undefined]) {
      update(false, snapshot(report))
      expect(pill('Permissions').props).toMatchObject({
        disabled: !report,
        accessibilityLabel: `Permissions, ${report ? label : 'Permissions'}`
      })
    }
    update(false, snapshot(mode))
    await act(async () => pill('Permissions').props.onPress())
    const rows = findByHostType(renderer!.root, 'BottomDrawer').findAll(
      (node) => node.props.accessibilityRole === 'radio'
    )
    expect(
      rows
        .filter((row) => row.props.accessibilityState.checked)
        .map((row) => findAllByHostType(row, 'Text')[0]?.props.children)
    ).toEqual(['accept-edits', 'full-access'].includes(mode) ? [label] : [])
    expect(
      findAllByHostType(renderer!.root, 'Text').some((node) =>
        String(node.props.children).includes('own settings')
      )
    ).toBe(false)
    await act(async () => rowByText('Full access').props.onPress())
    expect(setOption).toHaveBeenCalledExactlyOnceWith('permissionMode', 'full-access')
  })

  it.each([
    ['ask', 'Ask for approval', 'Hand', 'full-access', 'Full access'],
    ['full-access', 'Full access', 'ShieldAlert', 'ask', 'Ask for approval'],
    ['host', "Host's Agent Permissions", null, 'ask', 'Ask for approval']
  ] as const)(
    'names the permission-only %s pill and closes its labeled sheet on a pick',
    async (value, label, icon, nextValue, nextLabel) => {
      const choices = [
        { value, label },
        { value: nextValue, label: nextLabel }
      ]
      const kind = { type: 'select' as const, currentValue: value, choices }
      mount([{ ...PERMISSION_DESCRIPTOR, kind }], true)
      expect(pill('Permissions').props).toMatchObject({
        accessibilityLabel: `Permissions, ${label}`,
        disabled: false
      })
      expect(findAllByHostType(renderer!.root, 'Text')).toHaveLength(icon ? 0 : 2)
      expect(findAllByHostType(renderer!.root, 'ShieldAlert')).toHaveLength(
        value === 'full-access' ? 1 : 0
      )
      if (icon) {
        expect(findAllByHostType(renderer!.root, icon)).toHaveLength(1)
        expect(findByHostType(renderer!.root, icon).props.color).toBe(
          value === 'full-access' ? colors.statusAmber : colors.textSecondary
        )
      }
      setOption.mockImplementation(() => new Promise(() => {}))
      await act(async () => pill('Permissions').props.onPress())
      expect(rowByText(nextLabel).props.accessibilityRole).toBe('radio')
      await act(async () => rowByText(nextLabel).props.onPress())
      expect(setOption).toHaveBeenCalledWith('permissionMode', nextValue)
      expect(findAllByHostType(renderer!.root, 'BottomDrawer')).toEqual([])
    }
  )
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
