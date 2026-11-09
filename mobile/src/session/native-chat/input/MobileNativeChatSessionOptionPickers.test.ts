import type { AgentSessionOptionsResult } from '../../../../../src/shared/agent-session/options/agent-session-options-result'
import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'
import {
  OPTIONS,
  BASE,
  deferred,
  accepted,
  optionsClient,
  recordingMutate,
  mountOptions,
  settle
} from '../../use-mobile-structured-agent-options.test-fixture'
import { createElement, useState, type ReactNode } from 'react'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../../../test-support/query-client-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessibilityInfo, Platform } from 'react-native'

import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatPickerPresentation
} from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'

vi.mock('../../../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
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
vi.mock('../../../components/bottom-drawer/BottomDrawer', async () => {
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

  it('picks the shown Codex default during a reply and captures it only for the next message', async () => {
    const pending = deferred<AgentSessionOptionsResult>()
    let reads = 0
    const rpc = optionsClient(() =>
      ++reads === 1
        ? Promise.resolve({
            ...OPTIONS,
            listedModelIds: OPTIONS.models.map((row) => row.id),
            current: { model: 'gpt-fast', acceptedInputSources: { model: 'saved' }, defaulted: [] }
          })
        : pending.promise
    )
    const { calls, mutate } = recordingMutate(async () =>
      accepted({ key: 'effort', value: 'low', options: { effort: 'low' } }, true)
    )
    const view = await mountOptions({ ...BASE, client: rpc.client, mutate, sendSelection: true })
    const snapshot = () => [...view.current().optionSnapshot]
    try {
      const update = mount(snapshot(), true)
      const running = view.current().sendSelection()
      expect(running).toEqual({ selection: { model: 'gpt-fast' } })
      await act(async () => pill('Model').props.onPress())
      setOption.mockImplementation(view.current().setStructuredOption)
      await act(async () => pill('Low').props.onPress())
      await settle()
      expect(calls.map((call) => call.fields)).toEqual([{ key: 'effort', value: 'low' }])
      expect(view.current().sendSelection()).toEqual({
        selection: { model: 'gpt-fast', effort: 'low' }
      })
      expect(running).toEqual({ selection: { model: 'gpt-fast' } })
      update(true, snapshot())
      await act(async () => pill('Low').props.onPress())
      expect(setOption).toHaveBeenCalledTimes(1)
    } finally {
      await view.unmount()
    }
  })

  it('renders actual settled permission/reset picks without busy state and locks ordinary pending model work', async () => {
    const idle = deferred<AgentSessionOptionsResult>()
    let reads = 0
    const rpc = optionsClient(() =>
      ++reads === 1
        ? Promise.resolve({ ...OPTIONS, current: { ...OPTIONS.current, permissionMode: 'ask' } })
        : idle.promise
    )
    const replies = Array.from({ length: 3 }, () => deferred<ReturnType<typeof accepted>>())
    const { calls, mutate } = recordingMutate((index) => replies[index].promise)
    const view = await mountOptions({ ...BASE, client: rpc.client, mutate, permissionOwn: true })
    function ActualPickers() {
      const options = view.current()
      const { nativeChatSessionOptions } = useMobileNativeChatSessionOptionController({
        client: rpc.client,
        activeChatStructured: true,
        activeSessionTabId: BASE.sessionId,
        agent: 'codex',
        dispatchCommand: async () => 'accepted',
        hostId: 'phone-picker',
        isTabChatView: () => true,
        isWorking: true,
        reportedModel: null,
        structured: {
          snapshot: options.optionSnapshot,
          pendingId: options.pendingOptionId,
          setOption: options.setStructuredOption,
          invokeAction: options.invokeStructuredOption
        },
        toggleTabChatView: () => {},
        worktreeId: 'workspace-1'
      })
      return createElement(MobileNativeChatSessionOptionPickers, {
        ...nativeChatSessionOptions!,
        presentation: { page: 'model', refocus: false },
        onDrawerOpen: () => {},
        onNavigate: () => {}
      })
    }
    try {
      await act(async () => {
        renderer = createWithQueryClient(createElement(ActualPickers))
      })
      for (const [index, value] of ['full-access', 'own'].entries()) {
        let pick!: Promise<boolean>
        act(() => {
          pick = view.current().setStructuredOption('permissionMode', value)
        })
        expect(calls[index]?.fields).toEqual({ key: 'permissionMode', value })
        expect(view.current().pendingOptionId).toBeNull()
        await act(async () => renderer!.update(createElement(ActualPickers)))
        expect(renderer!.root.findAllByProps({ children: 'Applying…' })).toHaveLength(0)
        expect(rowByText('GPT Fast').props.accessibilityState?.disabled).toBe(false)
        await act(async () =>
          replies[index].resolve(
            accepted({ key: 'permissionMode', value, options: { permissionMode: value } }, true)
          )
        )
        await expect(pick).resolves.toBe(true)
        expect(view.current().pendingOptionId).toBeNull()
        await act(async () => renderer!.update(createElement(ActualPickers)))
        expect(renderer!.root.findAllByProps({ children: 'Applying…' })).toHaveLength(0)
        expect(rowByText('GPT Fast').props.accessibilityState?.disabled).toBe(false)
      }
      act(() => {
        void view.current().setStructuredOption('model', 'gpt-fast')
      })
      await act(async () => renderer!.update(createElement(ActualPickers)))
      expect(rowByText('GPT Live').props.accessibilityState?.disabled).toBe(true)
      expect(renderer!.root.findAllByProps({ children: 'Applying…' })).toHaveLength(1)
      expect(calls.map((call) => call.fields)).toEqual([
        { key: 'permissionMode', value: 'full-access' },
        { key: 'permissionMode', value: 'own' },
        { key: 'model', value: 'gpt-fast' }
      ])
    } finally {
      await view.unmount()
    }
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
