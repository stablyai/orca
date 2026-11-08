import { markRpcDeliveryUnknown } from '../../../transport/rpc-delivery-ambiguity'
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'
import {
  setMobileNativeChatDraftText,
  readMobileNativeChatDraftEditGeneration
} from './mobile-native-chat-draft-store'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs,
  resetMobileNativeChatDraftInputsForTests
} from './mobile-native-chat-draft-inputs'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { useMobileStructuredNativeChatSendBridge } from '../../use-mobile-structured-native-chat-send-bridge'
import { mobileNativeChatScopeKey } from '../mobile-native-chat-scope-key'
import { useMobileStructuredAgentSession } from '../../use-mobile-structured-agent-session'
import {
  CAPABLE,
  SESSION_ID,
  batchEvent,
  queuedDraft,
  snapshotEvent,
  mutationOk,
  ok
} from '../../use-mobile-structured-agent-session-queued.test-fixture'
import { structuredSendResultFixture } from '../../structured-agent-send-result.test-fixture'
import { findByHostType } from '../../../test-support/react-test-renderer-host-nodes'
import type { RpcClient } from '../../../transport/rpc-client'
import { structuredAgentSessionHostSupport } from '../../mobile-structured-agent-session-host-support'
import { AGENT_SESSION_RUNTIME_CAPABILITIES } from '../../../../../src/shared/agent-session/agent-session-runtime-capabilities'
import { useMobileStructuredAgentOptions } from '../../use-mobile-structured-agent-options'
import {
  optionsClient,
  recordingMutate,
  accepted
} from '../../use-mobile-structured-agent-options.test-fixture'
import type { AgentSessionOptionResult } from '../../../../../src/shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionMutationResult } from '../../mobile-structured-agent-session-rpc'
import { createElement, useState, type ComponentProps } from 'react'
import type { SessionOptionDescriptor } from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../../../test-support/query-client-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MobileNativeChatComposer as NativeChatComposer,
  MobileNativeChatDraftComposer
} from './MobileNativeChatComposer'
vi.mock('../../../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('./MobileNativeChatContextUsageRing', () => ({
  useMobileNativeChatContextRing: () => ({ barProps: {}, ring: null })
}))
vi.mock('../../../platform/media-picker', () => ({
  useMediaPicker: () => ({ pickImages: async () => [] })
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

const getNoComposerEditGeneration = () => 0

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, { ...props, getComposerEditGeneration })
}

// BottomDrawer also carries the option pager, which loads Reanimated at import.
vi.mock('react-native-reanimated', async () =>
  (await import('../../../test-support/reanimated-pager-stub')).reanimatedPagerStub()
)
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ...(await import('../../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  AtSign: 'AtSign',
  Image: 'Image',
  Paperclip: 'Paperclip',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  CornerDownRight: 'CornerDownRight',
  FileText: 'FileText',
  Goal: 'Goal',
  PencilRuler: 'PencilRuler',
  ListEnd: 'ListEnd',
  Mic: 'Mic',
  Package: 'Package',
  Plus: 'Plus',
  ShieldAlert: 'ShieldAlert',
  Square: 'Square',
  Terminal: 'Terminal',
  X: 'X'
}))

vi.mock('../../../components/bottom-drawer/mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'BottomDrawer'
}))
vi.mock('../../../components/bottom-drawer/bottom-drawer-modal-host-scope', () => ({
  useBottomDrawerModalHost: () => null
}))

const structured = (
  overrides: Partial<NonNullable<ComponentProps<typeof NativeChatComposer>['structured']>> = {}
) => ({
  catalog: {
    reported: [
      { name: 'compact', kind: 'command' as const },
      { name: 'review-pr', kind: 'skill' as const, description: 'Review a pull request' }
    ],
    conversationCommands: []
  },
  onSlashMenuOpen: vi.fn(),
  files: [],
  onRemoveFile: vi.fn(),
  ...overrides
})

describe('MobileNativeChatComposer on a structured chat', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(async () => {
    act(() => renderer?.unmount())
    renderer = null
    await activateMobileUiLocale('en')
  })

  const draw = (props: Partial<ComponentProps<typeof MobileNativeChatComposer>>) =>
    createElement(MobileNativeChatComposer, {
      value: '',
      onChangeText: vi.fn(),
      onSend: vi.fn().mockResolvedValue(true),
      sendSurfaceId: 'tab-a',
      getSendCompletionGeneration: () => 0,
      agent: 'claude',
      ...props
    })
  const field = () => renderer!.root.find((node) => node.props.multiline === true)
  const labelled = (label: string) =>
    renderer!.root.findAll(
      (node) => node.props.accessibilityLabel === label && node.props.onPress !== undefined
    )
  const drawers = () => renderer!.root.findAll((node) => node.props.onHidden !== undefined)

  it.each(['claude', 'codex'] as const)(
    '%s picks native mode without sending its draft or attachments',
    async (agent) => {
      const snapshot: SessionOptionDescriptor[] = [
        {
          id: 'interactionMode',
          label: 'Mode',
          category: 'mode',
          kind: {
            type: 'select',
            currentValue: 'default',
            choices: [
              { value: 'default', label: 'Build' },
              { value: 'plan', label: 'Plan' }
            ]
          },
          valueSource: 'default',
          transport: 'agent-session',
          settable: true
        }
      ]
      let eligible = false
      const reply = Promise.withResolvers<boolean>()
      const setOption = vi.fn(() => reply.promise)
      const onSend = vi.fn(async () => true)
      const focus = vi.fn()
      const onRemoveAttachment = vi.fn()
      function Conversation() {
        const [value, onChangeText] = useState('keep /pl tail')
        return draw({
          agent,
          value,
          onChangeText,
          onSend,
          structured: structured(),
          sessionOptions: {
            isWorking: false,
            controller: {
              snapshot,
              optionSurface: {
                admits: () => eligible,
                getSnapshot: () => snapshot,
                setOption: async () => ({ snapshot }),
                invokeAction: async () => ({ snapshot }),
                subscribe: () => () => {}
              },
              pendingId: null,
              setOption,
              invokeAction: async () => false,
              recordCommand: () => {}
            }
          },
          attachments: [
            { id: 'kept-image', path: '/remote/kept.png', previewUri: 'file:///kept.png' }
          ],
          onRemoveAttachment
        })
      }
      await act(async () => {
        renderer = createWithQueryClient(createElement(Conversation), {
          createNodeMock: (element) => (element.type === 'TextInput' ? { focus } : null)
        })
      })
      act(() => field().props.onSelectionChange({ nativeEvent: { selection: { end: 8 } } }))
      await act(async () => labelled('/plan')[0]!.props.onPress())
      expect(field().props.value).toBe('keep /pl tail')
      expect(setOption).not.toHaveBeenCalled()
      expect(labelled('/plan')).not.toHaveLength(0)
      eligible = true
      await act(async () => labelled('/plan')[0]!.props.onPress())
      expect(setOption).toHaveBeenLastCalledWith('interactionMode', 'plan')
      expect(field().props.value).toBe('keep  tail')
      expect(field().props.selection).toEqual({ start: 5, end: 5 })
      expect(focus).toHaveBeenCalled()
      act(() => field().props.onChangeText('later typing'))
      focus.mockClear()
      await act(async () => reply.resolve(false))
      expect(field().props.value).toBe('later typing')
      expect(focus).not.toHaveBeenCalled()
      if (agent === 'codex') {
        act(() => field().props.onChangeText('/def'))
        act(() => field().props.onSelectionChange({ nativeEvent: { selection: { end: 4 } } }))
        await act(async () => labelled('/default')[0]!.props.onPress())
        expect(setOption).toHaveBeenLastCalledWith('interactionMode', 'default')
        expect(field().props.value).toBe('')
      }
      expect(onSend).not.toHaveBeenCalled()
      expect(onRemoveAttachment).not.toHaveBeenCalled()
    }
  )

  it('retries a held opposite pick after settlement and exits Plan without consuming the draft', async () => {
    let mode: 'default' | 'plan' = 'default'
    const client = optionsClient(async () => ({
      models: [],
      current: { interactionMode: mode, acceptedInputSources: { interactionMode: 'saved' } }
    }))
    const reply =
      Promise.withResolvers<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>()
    const exitReply =
      Promise.withResolvers<StructuredAgentSessionMutationResult<AgentSessionOptionResult>>()
    const { calls, mutate } = recordingMutate(async (index, fields) =>
      index === 0
        ? reply.promise
        : index === 4
          ? exitReply.promise
          : accepted({ key: String(fields.key), value: String(fields.value) }, true)
    )
    let options: ReturnType<typeof useMobileStructuredAgentOptions> | undefined
    const focus = vi.fn()
    const onSend = vi.fn(async () => true)
    function Conversation() {
      const [value, onChangeText] = useState('keep /pl tail')
      options = useMobileStructuredAgentOptions({
        agent: 'codex',
        client: client.client,
        sessionId: 'phone-plan-pending',
        enabled: true,
        fence: 1,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate,
        hostSupport: CAPABLE
      })
      return draw({
        agent: 'codex',
        value,
        onChangeText,
        onSend,
        structured: structured(),
        sessionOptions: {
          isWorking: false,
          controller: {
            snapshot: options.optionSnapshot,
            optionSurface: options.optionSurface,
            pendingId: options.pendingOptionId,
            setOption: options.setStructuredOption,
            invokeAction: options.invokeStructuredOption,
            recordCommand: () => {}
          }
        },
        attachments: [{ id: 'retained', path: '/remote/kept.png', previewUri: 'file:///kept.png' }]
      })
    }
    await act(async () => {
      renderer = createWithQueryClient(createElement(Conversation), {
        createNodeMock: (element) => (element.type === 'TextInput' ? { focus } : null)
      })
    })
    expect(labelled('Exit plan mode')).toHaveLength(0)
    act(() => field().props.onSelectionChange({ nativeEvent: { selection: { end: 8 } } }))
    await act(async () => labelled('/plan')[0]!.props.onPress())
    expect(field().props.value).toBe('keep  tail')
    expect(calls).toHaveLength(1)
    expect(labelled('Exit plan mode')[0]!.props.disabled).toBe(true)
    expect(labelled('Exit plan mode')[0]!.props.accessibilityState).toEqual({ disabled: true })
    expect(options!.optionSnapshot.find((entry) => entry.id === 'interactionMode')?.settable).toBe(
      false
    )
    await act(async () => {
      await options!.setStructuredOption('effort', 'high')
    })
    expect(options!.optionSnapshot.find((entry) => entry.id === 'interactionMode')?.settable).toBe(
      false
    )
    act(() => field().props.onChangeText('keep /def tail'))
    act(() => field().props.onSelectionChange({ nativeEvent: { selection: { end: 9 } } }))
    await act(async () => labelled('/default')[0]!.props.onPress())
    expect(field().props.value).toBe('keep /def tail')
    expect(calls).toHaveLength(2)
    expect(labelled('/default')).not.toHaveLength(0)
    mode = 'plan'
    await act(async () =>
      reply.resolve(
        accepted(
          { key: 'interactionMode', value: 'plan', options: { interactionMode: 'plan' } },
          true
        )
      )
    )
    expect(options!.optionSnapshot.find((entry) => entry.id === 'interactionMode')?.settable).toBe(
      true
    )
    expect(labelled('Exit plan mode')[0]!.props.disabled).toBe(false)
    mode = 'default'
    await act(async () => labelled('/default')[0]!.props.onPress())
    expect(field().props.value).toBe('keep  tail')
    expect(calls).toHaveLength(3)
    expect(calls[2]!.fields).toEqual({ key: 'interactionMode', value: 'default' })
    expect(labelled('Exit plan mode')).toHaveLength(0)
    mode = 'plan'
    act(() => field().props.onChangeText('keep /pl tail'))
    act(() => field().props.onSelectionChange({ nativeEvent: { selection: { end: 8 } } }))
    await act(async () => labelled('/plan')[0]!.props.onPress())
    expect(calls).toHaveLength(4)
    act(() => field().props.onChangeText('keep /def tail'))
    focus.mockClear()
    act(() => labelled('Exit plan mode')[0]!.props.onPress())
    expect(labelled('Exit plan mode')).toHaveLength(0)
    expect(field().props.value).toBe('keep /def tail')
    expect(focus).toHaveBeenCalled()
    expect(calls).toHaveLength(5)
    expect(calls[4]!.fields).toEqual({ key: 'interactionMode', value: 'default' })
    mode = 'default'
    await act(async () =>
      exitReply.resolve(
        accepted(
          { key: 'interactionMode', value: 'default', options: { interactionMode: 'default' } },
          true
        )
      )
    )
    expect(labelled('Exit plan mode')).toHaveLength(0)
    expect(field().props.value).toBe('keep /def tail')
    expect(
      renderer!.root.findAll((node) => node.props.source?.uri === 'file:///kept.png')
    ).not.toHaveLength(0)
    expect(focus).toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'accepted'],
    ['See this', 'accepted'],
    ['See this', 'unknown']
  ] as const)(
    'keeps an ordinary image with %j text after a real RPC %s result and clears its visible chip',
    async (text, outcome) => {
      const scope = mobileNativeChatScopeKey('host', 'worktree', `image-rpc-${text}`)!
      resetMobileNativeChatDraftInputsForTests()
      setMobileNativeChatDraftText(scope, text)
      updateMobileNativeChatDraftInputs(scope, (input) => ({
        ...input,
        images: [{ id: 'photo', path: '/remote/photo.png', previewUri: 'file:///phone-photo.png' }]
      }))
      let publish: ((data: unknown) => void) | undefined
      let sessionView: ReturnType<typeof useMobileStructuredAgentSession> | undefined
      const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => {
        if (method === 'agentSession.send') {
          if (outcome === 'unknown') {
            throw markRpcDeliveryUnknown(new Error('connection lost'))
          }
          return mutationOk(structuredSendResultFixture('accepted'))
        }
        return ok({ models: [], current: {} })
      })
      const client: RpcClient = {
        sendRequest,
        subscribe: (_m, _p, listener) => {
          publish = listener
          return () => {}
        },
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => null,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      }
      function Conversation() {
        const session = useMobileStructuredAgentSession({
          client,
          pairedHostClient: client,
          sessionId: SESSION_ID,
          sourceIdentity: 'host',
          enabled: true,
          connected: true,
          agent: 'codex',
          hostSupport: { ...CAPABLE, sendSkills: true },
          composerScopeKey: scope,
          onSendError: vi.fn()
        })
        sessionView = session
        const drafts = useMobileNativeChatDrafts({
          hostId: 'host',
          worktreeId: 'worktree',
          tabId: `image-rpc-${text}`,
          sessionId: SESSION_ID,
          messages: [],
          transcriptSettled: true
        })
        const bridge = useMobileStructuredNativeChatSendBridge({
          ...drafts,
          agent: 'codex',
          sendStructured: session.sendWithOutcome,
          holdUnconfirmed: session.holdUnconfirmed,
          onSendError: vi.fn()
        })
        const image = useMobileNativeChatImageAttachments({
          client,
          agent: 'codex',
          activeHandleRef: { current: null },
          deviceTokenRef: { current: null },
          getActiveWorktreeConnectionId: async () => null,
          connState: 'connected',
          scopeKey: scope,
          enabled: true,
          structuredNativeChat: true,
          showToast: vi.fn(),
          onSendError: vi.fn(),
          baseSend: bridge.sendWithOutcome,
          readSeededLaunchDraft: () => null
        })
        return draw({
          value: text,
          onSend: image.sendNativeChat,
          attachments: image.attachments,
          onRemoveAttachment: image.removeAttachment,
          structured: structured()
        })
      }
      await act(async () => {
        renderer = createWithQueryClient(createElement(Conversation))
      })
      act(() => publish?.(snapshotEvent()))
      expect(labelled('Remove image')[0]).toBeDefined()
      await act(async () => labelled('Send message')[0]!.props.onPress())
      const request = sendRequest.mock.calls.find(([method]) => method === 'agentSession.send')?.[1]
      expect(request).toMatchObject({
        body: {
          blocks: [
            ...(text ? [{ type: 'text', text }] : []),
            { type: 'image-ref', path: '/remote/photo.png' }
          ]
        }
      })
      expect(readMobileNativeChatDraftInputs(scope).images).toEqual([])
      expect(labelled('Remove image')).toEqual([])
      if (outcome === 'unknown') {
        expect(sessionView!.session.messages).toHaveLength(1)
        expect(sessionView!.session.messages[0]?.blocks).toEqual([
          { type: 'text', text },
          { type: 'image-ref', path: '/remote/photo.png' }
        ])
        expect(Object.values(sessionView!.imagePreviewsByMessageId)).toEqual([
          ['file:///phone-photo.png']
        ])
      }
    }
  )

  it.each([
    ['codex', '$review.v2'],
    ['claude', '/review.v2']
  ] as const)(
    '%s matches main capture/clear and real Send refs, and forgets a deleted pick',
    async (agent, token) => {
      const scope = mobileNativeChatScopeKey('host', 'worktree', 'menu')!
      resetMobileNativeChatDraftInputsForTests()
      setMobileNativeChatDraftText(scope, '/re')
      let publish: ((data: unknown) => void) | undefined
      const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) =>
        method === 'agentSession.send'
          ? mutationOk(structuredSendResultFixture('accepted'))
          : ok({ models: [], current: {} })
      )
      const client: RpcClient = {
        sendRequest,
        subscribe: (_m, _p, listener) => {
          publish = listener
          return () => {}
        },
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => null,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      }
      function Conversation() {
        const session = useMobileStructuredAgentSession({
          client,
          pairedHostClient: client,
          sessionId: SESSION_ID,
          sourceIdentity: 'host',
          enabled: true,
          connected: true,
          agent,
          hostSupport: { ...CAPABLE, sendSkills: true },
          composerScopeKey: scope,
          onSendError: vi.fn()
        })
        const drafts = useMobileNativeChatDrafts({
          hostId: 'host',
          worktreeId: 'worktree',
          tabId: 'menu',
          sessionId: SESSION_ID,
          messages: [],
          transcriptSettled: true
        })
        const bridge = useMobileStructuredNativeChatSendBridge({
          ...drafts,
          agent,
          sendStructured: session.sendWithOutcome,
          holdUnconfirmed: session.holdUnconfirmed,
          onSendError: vi.fn()
        })
        return createElement(MobileNativeChatDraftComposer, {
          draftKey: scope,
          agent,
          draftScopeKey: scope,
          onChangeText: drafts.setComposerText,
          onSend: (text: string) => bridge.send(text),
          sendSurfaceId: scope,
          getSendCompletionGeneration: () => 0,
          getComposerEditGeneration: () => readMobileNativeChatDraftEditGeneration(scope),
          structured: structured({
            catalog: {
              reported: [{ name: 'review.v2', kind: 'skill', path: '/remote/review/SKILL.md' }],
              conversationCommands: []
            }
          })
        })
      }
      await act(async () => {
        renderer = createWithQueryClient(createElement(Conversation))
      })
      act(() => publish?.(snapshotEvent()))
      act(() => field().props.onSelectionChange({ nativeEvent: { selection: { end: 3 } } }))
      await act(async () => labelled(token)[0]!.props.onPress())
      expect(field().props.value).toBe(`${token} `)
      await act(async () => labelled('Send message')[0]!.props.onPress())
      const request = sendRequest.mock.calls.find(([method]) => method === 'agentSession.send')?.[1]
      const skills = [{ name: 'review.v2', path: '/remote/review/SKILL.md' }]
      expect(request).toMatchObject({ body: { blocks: [{ type: 'text', text: token }] } })
      if (agent === 'codex') {
        expect(request).toHaveProperty('body.skills', skills)
      } else {
        expect(request).not.toHaveProperty('body.skills')
      }
      expect(field().props.value).toBe('')
      expect(readMobileNativeChatDraftInputs(scope).skills).toEqual(skills)
      act(() => field().props.onChangeText(`${token} `))
      await act(async () => labelled('Send message')[0]!.props.onPress())
      const second = sendRequest.mock.calls.findLast(
        ([method]) => method === 'agentSession.send'
      )?.[1]
      if (agent === 'codex') {
        expect(second).toHaveProperty('body.skills', skills)
      } else {
        expect(second).not.toHaveProperty('body.skills')
      }
      // Pick again, delete, then retype: text alone cannot resurrect the old remote identity.
      act(() => field().props.onChangeText('/re'))
      act(() => field().props.onSelectionChange({ nativeEvent: { selection: { end: 3 } } }))
      await act(async () => labelled(token)[0]!.props.onPress())
      act(() => field().props.onChangeText(''))
      act(() => field().props.onChangeText(`${token} `))
      expect(readMobileNativeChatDraftInputs(scope).skills).toEqual([])
      await act(async () => labelled('Send message')[0]!.props.onPress())
      expect(
        sendRequest.mock.calls.findLast(([method]) => method === 'agentSession.send')?.[1]
      ).not.toHaveProperty('body.skills')
    }
  )

  it('the hold choice and a tap reach the outgoing request through the real send path', async () => {
    const scope = mobileNativeChatScopeKey('host', 'worktree', 'hold-choice')!
    resetMobileNativeChatDraftInputsForTests()
    setMobileNativeChatDraftText(scope, 'hi')
    // The phone's own mapping of what this build's host advertises.
    const advertised = structuredAgentSessionHostSupport(AGENT_SESSION_RUNTIME_CAPABILITIES)
    expect(advertised.queuedMessages).toBe(true)
    let publish: ((data: unknown) => void) | undefined
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) =>
      method === 'agentSession.send'
        ? mutationOk(structuredSendResultFixture('accepted'))
        : method === 'settings.get'
          ? ok({ settings: {} })
          : ok({ models: [], current: {} })
    )
    const client: RpcClient = {
      sendRequest,
      subscribe: (method, _p, listener) => {
        if (method === 'agentSession.subscribe') {
          publish = listener
        }
        return () => {}
      },
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    function Conversation() {
      const session = useMobileStructuredAgentSession({
        client,
        pairedHostClient: client,
        sessionId: SESSION_ID,
        sourceIdentity: 'host',
        enabled: true,
        connected: true,
        agent: 'claude',
        hostSupport: { ...CAPABLE, queuedMessages: advertised.queuedMessages },
        composerScopeKey: scope,
        onSendError: vi.fn()
      })
      const drafts = useMobileNativeChatDrafts({
        hostId: 'host',
        worktreeId: 'worktree',
        tabId: 'hold-choice',
        sessionId: SESSION_ID,
        messages: [],
        transcriptSettled: true
      })
      const bridge = useMobileStructuredNativeChatSendBridge({
        ...drafts,
        agent: 'claude',
        sendStructured: session.sendWithOutcome,
        holdUnconfirmed: session.holdUnconfirmed,
        onSendError: vi.fn()
      })
      const image = useMobileNativeChatImageAttachments({
        client,
        agent: 'claude',
        activeHandleRef: { current: null },
        deviceTokenRef: { current: null },
        getActiveWorktreeConnectionId: async () => null,
        connState: 'connected',
        scopeKey: scope,
        enabled: true,
        structuredNativeChat: true,
        showToast: vi.fn(),
        onSendError: vi.fn(),
        baseSend: bridge.sendWithOutcome,
        readSeededLaunchDraft: () => null
      })
      return draw({
        value: 'hi',
        onSend: image.sendNativeChat,
        sendFollowUp: session.sendFollowUp,
        structured: structured()
      })
    }
    await act(async () => {
      renderer = createWithQueryClient(createElement(Conversation))
    })
    await act(async () =>
      publish?.({
        ...snapshotEvent(),
        page: {
          ...snapshotEvent().page,
          working: true,
          latestTurn: null,
          nextQueuedMessageId: null
        }
      })
    )
    const sends = () =>
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.send').map(([, p]) => p)
    const send = () => labelled('Send message')[0]!
    // Like desktop, the arrow stays while the agent works; a hold is the only other way.
    expect(send().findAll((node) => String(node.type) === 'ArrowUp')).toHaveLength(1)
    await act(async () => send().props.onLongPress())
    const steer = drawers()[0]!.findAll(
      (node) =>
        String(node.type) === 'Pressable' &&
        node.findAll((child) => child.props.children === 'Steer').length > 0
    )[0]!
    await act(async () => steer.props.onPress())
    expect(sends()).toHaveLength(1)
    expect(sends()[0]).not.toHaveProperty('delivery')

    await act(async () => send().props.onPress())
    expect(sends()).toHaveLength(2)
    expect(sends()[1]).toHaveProperty('delivery', 'queue-if-active')

    // A waiting command queues either way, so a hold is a tap.
    const compact = queuedDraft({
      messageId: 'compact',
      body: { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } }
    })
    await act(async () => publish?.(batchEvent([compact])))
    expect(send().props.onLongPress).toBeUndefined()
  })
  it('forgets inline picked skill identity after its token is removed and retyped', async () => {
    const scope = 'removed-skill'
    updateMobileNativeChatDraftInputs(scope, () => ({
      images: [],
      files: [],
      skills: [{ name: 'review', path: '/remote/SKILL.md' }]
    }))
    await act(async () => {
      renderer = createWithQueryClient(
        createElement(MobileNativeChatComposer, {
          draftScopeKey: scope,
          value: '$review draft',
          editSession: { cancel: vi.fn(), locked: false, refuseCommand: () => false },
          onChangeText: vi.fn(),
          onSend: async () => false,
          sendSurfaceId: scope,
          getSendCompletionGeneration: getNoComposerEditGeneration
        })
      )
    })
    const input = () => findByHostType(renderer!.root, 'TextInput')
    await act(async () => input().props.onChangeText('draft'))
    await act(async () => input().props.onChangeText('$review draft'))
    expect(readMobileNativeChatDraftInputs(scope).skills).toEqual([])
  })
})
