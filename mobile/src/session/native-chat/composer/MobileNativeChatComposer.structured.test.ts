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
import { AGENT_SESSION_RUNTIME_CAPABILITIES } from '../../../../../src/shared/agent-session-runtime-capabilities'
vi.mock('../../../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('../../../platform/media-picker', () => ({
  useMediaPicker: () => ({ pickImages: async () => [] })
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))
import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MobileNativeChatComposer as NativeChatComposer,
  MobileNativeChatDraftComposer
} from './MobileNativeChatComposer'

const getNoComposerEditGeneration = () => 0

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, { ...props, getComposerEditGeneration })
}

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
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
  ListEnd: 'ListEnd',
  Mic: 'Mic',
  Package: 'Package',
  Plus: 'Plus',
  ShieldAlert: 'ShieldAlert',
  Square: 'Square',
  Terminal: 'Terminal',
  X: 'X'
}))

vi.mock('../../../components/mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'BottomDrawer'
}))
vi.mock('../../../components/bottom-drawer-modal-host-scope', () => ({
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

  it.each(['', 'See this'])(
    'sends an ordinary image with %j text through the real RPC and clears its visible chip',
    async (text) => {
      const scope = mobileNativeChatScopeKey('host', 'worktree', `image-rpc-${text}`)!
      resetMobileNativeChatDraftInputsForTests()
      setMobileNativeChatDraftText(scope, text)
      updateMobileNativeChatDraftInputs(scope, (input) => ({
        ...input,
        images: [{ id: 'photo', path: '/remote/photo.png', previewUri: 'file:///phone-photo.png' }]
      }))
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
          sessionId: SESSION_ID,
          sourceIdentity: 'host',
          enabled: true,
          connected: true,
          agent: 'codex',
          hostSupport: { ...CAPABLE, sendSkills: true },
          composerScopeKey: scope,
          onSendError: vi.fn()
        })
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
        renderer = create(createElement(Conversation))
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
        renderer = create(createElement(Conversation))
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

  it('puts a picked skill at the start of the draft, highlighted, and deletes it as one unit', async () => {
    const onChangeText = vi.fn()
    const onSlashMenuDemand = vi.fn()
    const catalog = structured({ onSlashMenuDemand })
    await act(async () => {
      renderer = create(draw({ value: '/re', onChangeText, structured: catalog }))
    })
    await act(async () =>
      field().props.onSelectionChange({ nativeEvent: { selection: { end: 3 } } })
    )
    expect(catalog.onSlashMenuOpen).toHaveBeenCalled()
    expect(onSlashMenuDemand).toHaveBeenLastCalledWith(true)
    await act(async () => labelled('/review-pr')[0]!.props.onPress())
    expect(onChangeText).toHaveBeenLastCalledWith('/review-pr ')
    expect(field().props.selection).toEqual({ start: 11, end: 11 })

    await act(async () =>
      renderer!.update(draw({ value: '/review-pr focus', onChangeText, structured: catalog }))
    )
    expect(onSlashMenuDemand).toHaveBeenLastCalledWith(false)
    const token = field().find((node) => node.props.children === '/review-pr')
    expect(token.props.style).toMatchObject({ backgroundColor: expect.any(String) })
    await act(async () => field().props.onChangeText('/review-pr focus on auth'))
    expect(onChangeText).toHaveBeenLastCalledWith('/review-pr focus on auth')
    await act(async () => field().props.onChangeText('/review-prfocus'))
    expect(onChangeText).toHaveBeenLastCalledWith('focus')
  })

  it('opens the + sheet on a structured chat, and the photo library at once otherwise', async () => {
    const onAttachImage = vi.fn()
    await act(async () => {
      renderer = create(draw({ onAttachImage, structured: structured() }))
    })
    await act(async () => labelled('Add to message')[0]!.props.onPress())
    expect(onAttachImage).not.toHaveBeenCalled()
    expect(drawers()).toHaveLength(1)

    await act(async () => renderer!.update(draw({ onAttachImage, structured: null })))
    await act(async () => labelled('Attach image')[0]!.props.onPress())
    expect(onAttachImage).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      locale: 'en',
      send: 'Send message',
      queue: 'Queue',
      steer: 'Steer',
      queueHint: 'Runs after the current turn',
      steerHint: 'Goes into what the agent is doing now'
    },
    {
      locale: 'de',
      send: 'Nachricht senden',
      queue: 'Einreihen',
      steer: 'Steuern',
      queueHint: 'Läuft nach dem aktuellen Durchgang',
      steerHint: 'Fließt in das ein, was der Agent gerade tut'
    }
  ] as const)(
    'mid-turn Send shows what a tap does, and holding it offers the other way first-marked in $locale',
    async (labels) => {
      await activateMobileUiLocale(labels.locale)
      const onSend = vi.fn().mockResolvedValue(true)
      const choices = () =>
        drawers()[0]!.findAll(
          (node) => String(node.type) === 'Pressable' && node.props.onPress !== undefined
        )
      const text = (node: ReactTestInstance) =>
        node
          .findAll((child) => typeof child.props.children === 'string')
          .map((child) => child.props.children)
      await act(async () => {
        renderer = create(
          draw({ value: 'hi', onSend, sendFollowUp: { action: 'steer', offersChoice: true } })
        )
      })
      const send = () => labelled(labels.steer)[0]!
      expect(send().findAll((node) => String(node.type) === 'CornerDownRight')).toHaveLength(1)
      await act(async () => send().props.onLongPress())
      await act(async () => drawers()[0]!.props.onClose())
      expect(onSend).not.toHaveBeenCalled()

      await act(async () => send().props.onLongPress())
      expect(choices().map(text)).toEqual([
        [labels.steer, labels.steerHint],
        [labels.queue, labels.queueHint]
      ])
      expect(choices().map((choice) => choice.props.accessibilityState?.checked)).toEqual([
        true,
        undefined
      ])
      await act(async () => choices()[1]!.props.onPress())
      expect(onSend).toHaveBeenCalledExactlyOnceWith('hi', { alternate: true })
      await act(async () => send().props.onLongPress())
      await act(async () => choices()[0]!.props.onPress())
      expect(onSend).toHaveBeenCalledTimes(2)
      expect(onSend).toHaveBeenLastCalledWith('hi')

      // A waiting command queues either way: the button says so, and a hold is a tap.
      await act(async () =>
        renderer!.update(
          draw({ value: 'hi', onSend, sendFollowUp: { action: 'queue', offersChoice: false } })
        )
      )
      expect(labelled(labels.queue)[0]!.props.onLongPress).toBeUndefined()
      await act(async () => renderer!.update(draw({ value: 'hi', onSend, sendFollowUp: null })))
      expect(labelled(labels.send)[0]!.props.onLongPress).toBeUndefined()
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
      renderer = create(createElement(Conversation))
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
    const send = () => labelled('Queue')[0]!
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

  it('holds Send while a file is still uploading, and sends a stored file alone', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const file = { id: 'f1', name: 'spec.pdf', mime: 'application/pdf', byteLength: 10 }
    await act(async () => {
      renderer = create(
        draw({
          value: 'see attached',
          onSend,
          structured: structured({ files: [{ ...file, path: null }] })
        })
      )
    })
    expect(labelled('Send message')[0]!.props.disabled).toBe(true)
    await act(async () => labelled('Send message')[0]!.props.onPress())
    expect(onSend).not.toHaveBeenCalled()
    await act(async () =>
      renderer!.update(
        draw({ onSend, structured: structured({ files: [{ ...file, path: '/s/spec.pdf' }] }) })
      )
    )
    expect(labelled('Send message')[0]!.props.disabled).toBe(false)
    await act(async () => labelled('Send message')[0]!.props.onPress())
    expect(onSend).toHaveBeenCalledExactlyOnceWith('')
  })
  it('forgets inline picked skill identity after its token is removed and retyped', async () => {
    const scope = 'removed-skill'
    updateMobileNativeChatDraftInputs(scope, () => ({
      images: [],
      files: [],
      skills: [{ name: 'review', path: '/remote/SKILL.md' }]
    }))
    await act(async () => {
      renderer = create(
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
