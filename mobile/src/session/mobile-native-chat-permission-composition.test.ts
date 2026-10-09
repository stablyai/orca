import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { Pressable, Text } from 'react-native'
import type { AgentSessionPermissionSeed } from '../../../src/shared/agent-chat-permission-mode'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'
import { useMobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  ImagePlus: 'ImagePlus',
  Mic: 'Mic',
  Square: 'Square',
  X: 'X'
}))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children?: React.ReactNode }) =>
    visible ? createElement('BottomDrawer', { visible }, children) : null
}))
vi.mock('./mobile-native-chat-session-option-persistence', () => ({
  persistMobileStructuredOptionPicks: vi.fn()
}))

const seed: AgentSessionPermissionSeed = { mode: 'ask', fence: 7 }
const stateRef = { current: { ...EMPTY_STRUCTURED_AGENT_SESSION } }
let renderer: ReactTestRenderer | null = null

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
})

function success(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'host' } }
}

function holdOptions() {
  const replies: ((value: RpcResponse) => void)[] = []
  const failures: ((reason: Error) => void)[] = []
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'agentSession.modelCatalog') {
      // The host's model list has not answered: the model pill stays the quiet placeholder.
      return new Promise<RpcResponse>(() => {})
    }
    if (method === 'agentSession.options') {
      return new Promise<RpcResponse>((resolve, reject) => {
        replies.push(resolve)
        failures.push(reject)
      })
    }
    return success({
      ok: true,
      value: { key: 'permissionMode', value: 'auto', options: { permissionMode: 'auto' } }
    })
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
  return { client, sendRequest, replies, failures }
}

function Composer(props: {
  agent: string
  client: RpcClient
  permissionSeed?: AgentSessionPermissionSeed
}): React.JSX.Element {
  const mutate = useMobileStructuredAgentMutate({
    client: props.client,
    sessionId: 'chat',
    enabled: true,
    stateRef,
    permissionSeed: props.permissionSeed,
    onSendError: () => {}
  })
  const structured = useMobileStructuredAgentOptions({
    agent: props.agent,
    client: props.client,
    sessionId: 'chat',
    enabled: true,
    fence: null,
    permissionSeed: props.permissionSeed,
    mutate
  })
  const { nativeChatSessionOptions } = useMobileNativeChatSessionOptionController({
    client: props.client,
    agent: props.agent,
    activeChatStructured: true,
    activeSessionTabId: 'chat',
    dispatchCommand: async () => 'rejected',
    hostId: 'host',
    worktreeId: 'workspace',
    isTabChatView: () => true,
    isWorking: false,
    reportedModel: null,
    structured,
    toggleTabChatView: () => {}
  })
  return createElement(MobileNativeChatComposer, {
    agent: props.agent,
    value: '',
    onChangeText: () => {},
    onSend: async () => true,
    sendSurfaceId: 'chat',
    getSendCompletionGeneration: () => 0,
    getComposerEditGeneration: () => 0,
    sessionOptions: nativeChatSessionOptions
  })
}

function root() {
  if (!renderer) {
    throw new Error('Composer was not rendered')
  }
  return renderer.root
}

function pills(prefix: string) {
  return root().findAll(
    (node) =>
      node.type === Pressable &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(prefix)
  )
}

/** Only the quiet, unpickable model placeholder shows: no model is listed before a reply. */
function expectModelPlaceholder(): void {
  expect(root().findByType(MobileNativeChatComposer).props.sessionOptions).toMatchObject({
    controller: { snapshot: [{ id: 'model', settable: false, valueSource: 'unknown' }] }
  })
}

function optionReply(agent: string, current = 'ask'): RpcResponse {
  return success({
    models: [{ id: 'm', label: 'M', isDefault: true, efforts: [] }],
    current: { model: 'm' },
    permissionModes: {
      current,
      supported:
        agent === 'claude' ? ['ask', 'accept-edits', 'auto', 'bypass'] : ['ask', 'auto', 'bypass']
    }
  })
}

it.each(['claude', 'codex'])(
  'renders a usable %s permission button before the first options reply',
  async (agent) => {
    const { client, sendRequest, replies } = holdOptions()
    await act(async () => {
      renderer = create(createElement(Composer, { agent, client, permissionSeed: seed }))
    })
    expect(replies).toHaveLength(1)
    expectModelPlaceholder()
    expect(pills('Permissions,')).toHaveLength(1)
    expect(pills('Permissions,')[0].props).toMatchObject({
      accessibilityLabel: 'Permissions, Ask for approval',
      disabled: false
    })
    await act(async () => pills('Permissions,')[0].props.onPress())
    const choices = root().findAll(
      (node) => node.type === Pressable && node.props.accessibilityRole === 'radio'
    )
    expect(choices.map((choice) => choice.findAllByType(Text)[0].props.children)).toEqual(
      agent === 'claude'
        ? ['Ask for approval', 'Accept edits', 'Approve for me', 'Full access']
        : ['Ask for approval', 'Approve for me', 'Full access']
    )
    const auto = choices.find(
      (choice) => choice.findAllByType(Text)[0].props.children === 'Approve for me'
    )
    if (!auto) {
      throw new Error('Auto choice was not rendered')
    }
    expect(auto.props.disabled).toBe(false)
    await act(async () => auto.props.onPress())
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.setOption',
      expect.objectContaining({
        key: 'permissionMode',
        value: 'auto',
        envelope: expect.objectContaining({ expectedRuntimeFence: 7 })
      }),
      expect.anything()
    )
    expect(pills('Permissions,')[0].props.accessibilityLabel).toBe('Permissions, Approve for me')
    await act(async () => replies.at(-1)?.(optionReply(agent, 'auto')))
    expect(pills('Model,')).toHaveLength(1)
    expect(pills('Permissions,')[0].props.accessibilityLabel).toBe('Permissions, Approve for me')
  }
)

it.each(['claude', 'codex'])(
  'keeps the seeded %s button after an options read fails',
  async (agent) => {
    const { client, failures } = holdOptions()
    await act(async () => {
      renderer = create(createElement(Composer, { agent, client, permissionSeed: seed }))
    })
    expect(pills('Permissions,')).toHaveLength(1)
    await act(async () => failures[0](new Error('Host unavailable')))
    expectModelPlaceholder()
    expect(pills('Permissions,')).toHaveLength(1)
    expect(pills('Permissions,')[0].props).toMatchObject({
      accessibilityLabel: 'Permissions, Ask for approval',
      disabled: false
    })
  }
)

it.each(['claude', 'codex'])('waits for an older %s host that supplies no seed', async (agent) => {
  const { client, replies } = holdOptions()
  await act(async () => {
    renderer = create(createElement(Composer, { agent, client }))
  })
  expect(replies).toHaveLength(1)
  expectModelPlaceholder()
  expect(pills('Permissions,')).toHaveLength(0)
  await act(async () => replies[0](optionReply(agent)))
  expect(pills('Model,')).toHaveLength(1)
  expect(pills('Permissions,')[0].props).toMatchObject({
    accessibilityLabel: 'Permissions, Ask for approval',
    disabled: false
  })
})
