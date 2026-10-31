import { createElement, useState, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../src/shared/structured-agent-session-reducer'
import { useMobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import { fieldsOf } from './use-mobile-structured-agent-session-queued.test-fixture'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatPickerPresentation
} from './native-chat/input/MobileNativeChatSessionOptionPickers'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibilityWithOptions: vi.fn() },
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Switch: 'Switch',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
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
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
    visible ? createElement('BottomDrawer', null, children) : null
}))

it('shows an unknown model without sending or remembering a guess, then applies a real row pick', async () => {
  let answer: AgentSessionOptionsResult = {
    models: [{ id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }],
    current: {},
    conversationCommands: ['clear']
  }
  const writes: unknown[] = []
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
    if (method === 'agentSession.setOption') {
      expect(fieldsOf(params)).toMatchObject({ key: 'model', value: 'sonnet' })
      answer = { ...answer, current: { model: 'sonnet', confirmed: ['model'] } }
      return {
        id: 'rpc',
        ok: true,
        result: {
          ok: true,
          replayed: false,
          value: { key: 'model', value: 'sonnet', options: { model: 'sonnet' } }
        },
        _meta: { runtimeId: 'host-b' }
      }
    }
    if (method === 'settings.mutateNativeChatSessionOptions') {
      writes.push(params)
    }
    return {
      id: 'rpc',
      ok: true,
      result:
        method === 'agentSession.options'
          ? answer
          : method === 'agentSession.modelCatalog'
            ? { origin: 'unknown' }
            : {},
      _meta: { runtimeId: 'host-b' }
    }
  })
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const stateRef = { current: { ...EMPTY_STRUCTURED_AGENT_SESSION, fence: 1 } }
  let options!: ReturnType<typeof useMobileStructuredAgentOptions>
  function Chat() {
    const mutate = useMobileStructuredAgentMutate({
      client,
      sessionId: 'unknown-mobile',
      enabled: true,
      stateRef,
      onSendError: (message) => {
        throw new Error(message)
      }
    })
    options = useMobileStructuredAgentOptions({
      agent: 'claude',
      client,
      sessionId: 'unknown-mobile',
      enabled: true,
      fence: 1,
      turnId: null,
      mutate,
      hostSupport: {
        permissionModes: false,
        coherentModelCatalog: true,
        statusFeed: false,
        sendOptions: true
      }
    })
    const [presentation, setPresentation] = useState<MobileNativeChatPickerPresentation | null>(
      null
    )
    return createElement(MobileNativeChatSessionOptionPickers, {
      controller: {
        snapshot: options.optionSnapshot,
        pendingId: options.pendingOptionId,
        setOption: options.setStructuredOption,
        invokeAction: options.invokeStructuredOption,
        recordCommand: () => {}
      },
      isWorking: false,
      presentation,
      onDrawerOpen: (page) => setPresentation({ page, refocus: false }),
      onNavigate: (page) => setPresentation((previous) => previous && { ...previous, page })
    })
  }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(Chat))
  })
  try {
    await vi.waitFor(() =>
      expect(options.conversationCommands).toEqual(answer.conversationCommands)
    )
    const pill = () =>
      renderer.root.find(
        (node) =>
          String(node.type) === 'Pressable' &&
          String(node.props.accessibilityLabel).startsWith('Model,')
      )
    expect(pill().props.accessibilityLabel).toBe('Model, Model')
    expect(options.sendSelection()).toEqual({ options: undefined })
    expect(writes).toEqual([])
    expect(
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.setOption')
    ).toHaveLength(0)
    await act(async () => pill().props.onPress())
    const row = renderer.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        node.props.accessibilityRole === 'radio' &&
        findAllByHostType(node, 'Text').some((text) => text.props.children === 'Sonnet')
    )
    expect(row.props.accessibilityState.checked).toBe(false)
    await act(async () => row.props.onPress())
    expect(options.sendSelection()).toEqual({ options: { model: 'sonnet' } })
    expect(pill().props.accessibilityLabel).toBe('Model, Sonnet')
    await vi.waitFor(() =>
      expect(writes).toEqual([
        {
          type: 'apply-picks',
          agent: 'claude',
          picks: [{ modelId: 'sonnet', optionId: 'model', value: 'sonnet' }]
        }
      ])
    )
  } finally {
    await act(async () => renderer.unmount())
  }
})
