import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import { MobileNativeChatSessionOptionPickers } from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  X: 'X'
}))
vi.mock('../components/BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children?: unknown }) =>
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
  settable: true
}

const FAST_MODE_DESCRIPTOR: SessionOptionDescriptor = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', currentValue: false },
  valueSource: 'reported',
  settable: true
}

describe('MobileNativeChatSessionOptionPickers', () => {
  let renderer: ReactTestRenderer | null = null
  const setOption = vi.fn<MobileNativeChatSessionOptionsController['setOption']>()
  const invokeAction = vi.fn<MobileNativeChatSessionOptionsController['invokeAction']>()

  const mount = (snapshot: SessionOptionDescriptor[], isWorking = false): void => {
    const controller: MobileNativeChatSessionOptionsController = {
      snapshot,
      pendingId: null,
      setOption,
      invokeAction,
      recordCommand: vi.fn()
    }
    act(() => {
      renderer = create(
        createElement(MobileNativeChatSessionOptionPickers, { controller, isWorking })
      )
    })
  }

  const pill = (
    name: string
  ): {
    props: {
      onPress: () => void
      accessibilityLabel?: string
      disabled?: boolean
      accessibilityRole?: string
      accessibilityState?: { disabled?: boolean }
    }
  } =>
    renderer!.root.find(
      (node) =>
        node.type === 'Pressable' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith(name)
    ) as {
      props: {
        onPress: () => void
        accessibilityLabel?: string
        disabled?: boolean
        accessibilityRole?: string
        accessibilityState?: { disabled?: boolean }
      }
    }

  const rowByText = (
    text: string
  ): {
    props: {
      onPress: () => void
      accessibilityRole?: string
      accessibilityLabel?: string
      accessibilityState?: { checked?: boolean; disabled?: boolean }
    }
  } => {
    const label = renderer!.root
      .findAll((node) => node.type === 'Text')
      .find((node) => (node.props as { children?: unknown }).children === text)
    if (!label) {
      throw new Error(`No row labeled ${text}`)
    }
    let parent = label.parent
    while (parent && parent.type !== 'Pressable') {
      parent = parent.parent
    }
    if (!parent) {
      throw new Error(`No pressable row for ${text}`)
    }
    return parent as unknown as {
      props: {
        onPress: () => void
        accessibilityRole?: string
        accessibilityLabel?: string
        accessibilityState?: { checked?: boolean; disabled?: boolean }
      }
    }
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
    const labels = renderer!.root
      .findAll((node) => node.type === 'Text')
      .map((node) => (node.props as { children?: unknown }).children)
    expect(labels).toContain('Sonnet 5 High')
  })

  it('opens the model sheet and applies a picked model', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    expect(renderer!.root.findByType('BottomDrawer').props.visible).toBe(true)
    await act(async () => rowByText('Opus 4.8').props.onPress())
    expect(setOption).toHaveBeenCalledWith('model', 'opus')
  })

  it('opens an option picker from the model sheet summary', async () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    await act(async () => rowByText('Effort').props.onPress())
    await act(async () => rowByText('Low').props.onPress())
    expect(setOption).toHaveBeenCalledWith('effort', 'low')
  })

  it('shows absolute boolean values in option summaries', async () => {
    mount([MODEL_DESCRIPTOR, FAST_MODE_DESCRIPTOR])
    await act(async () => pill('Model').props.onPress())
    expect(rowByText('Off').props.accessibilityLabel).toBe('Fast mode, Off')
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

  it('closes without dispatch when re-picking the tracked value', async () => {
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
        action: { type: 'agent-picker' }
      }
    ])
    await act(async () => pill('Model').props.onPress())
    expect(rowByText('Choose in agent picker…').props.accessibilityRole).toBe('button')
    await act(async () => rowByText('Choose in agent picker…').props.onPress())
    expect(invokeAction).toHaveBeenCalledWith('model')
  })

  it('locks the pills while the agent is working', () => {
    mount([MODEL_DESCRIPTOR, EFFORT_DESCRIPTOR], true)
    expect(pill('Model').props).toMatchObject({ disabled: true })
  })
})
