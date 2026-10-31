import { QueuedMessageUpdateParams } from '../../../src/shared/rpc-contract/structured-agent-session-queued-edit-params'
import { useMobileNativeChatComposerMenu } from './native-chat/composer/use-mobile-native-chat-composer-menu'
import {
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './native-chat/composer/mobile-native-chat-draft-store'
import {
  updateMobileNativeChatDraftInputs,
  resetMobileNativeChatDraftInputsForTests
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageEditHoldResult
} from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { queuedMessageWithEdit } from '../../../src/shared/queued-message-edit'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  CAPABLE,
  batchEvent,
  SESSION_ID,
  fieldsOf,
  mutationOk,
  ok,
  snapshotEvent,
  queuedDraft
} from './use-mobile-structured-agent-session-queued.test-fixture'

export function withText(body: AgentSessionQueuedMessage['body'], text: string) {
  const edited = queuedMessageWithEdit(body, { text })
  if (!edited.ok) {
    throw new Error(edited.reason)
  }
  return edited.body
}

export function editHoldReply(params: unknown): RpcResponse {
  const result: AgentSessionQueuedMessageEditHoldResult =
    fieldsOf(params).action === 'release'
      ? { status: 'released' }
      : { status: 'held', fingerprint: 'fp', leaseDurationMs: 120_000, remainingMs: 120_000 }
  return ok(result)
}

export function readOrHoldReply(method: string, params: unknown): RpcResponse {
  return method === 'agentSession.queuedMessageEditHold'
    ? editHoldReply(params)
    : ok({ models: [], current: {} })
}

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ fontScale: 1 }),
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('lucide-react-native', () => ({
  FileText: 'FileText',
  Package: 'Package',
  Terminal: 'Terminal',
  ArrowUp: 'ArrowUp',
  AtSign: 'AtSign',
  AlertCircle: 'AlertCircle',
  Image: 'Image',
  Paperclip: 'Paperclip',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  CornerDownRight: 'CornerDownRight',
  ListEnd: 'ListEnd',
  MoreHorizontal: 'MoreHorizontal',
  Mic: 'Mic',
  Pencil: 'Pencil',
  Play: 'Play',
  Plus: 'Plus',
  Send: 'Send',
  ShieldAlert: 'ShieldAlert',
  Square: 'Square',
  Trash2: 'Trash2',
  X: 'X'
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

export function mobileQueuedEditHarness() {
  const state: {
    renderer?: ReactTestRenderer
    bottomText: string
    hook?: ReturnType<typeof useMobileStructuredAgentSession>
    menu?: ReturnType<typeof useMobileNativeChatComposerMenu>
    listener?: (data: unknown) => void
  } = { bottomText: '' }
  const append = vi.fn(() => true)
  const error = vi.fn()
  const notice = vi.fn()
  const resolved = vi.fn()
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client: RpcClient = {
    sendRequest,
    subscribe: (_method, _params, onData) => {
      state.listener = onData
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
  function Harness({
    sessionId = SESSION_ID,
    editSupport = true,
    enabled = true,
    connected = true,
    transport = client,
    composerScopeKey,
    imagesSupport = false,
    skillsSupport = false,
    agent = 'codex',
    renderContent
  }: {
    sessionId?: string
    editSupport?: boolean | null
    enabled?: boolean
    connected?: boolean
    transport?: RpcClient | null
    composerScopeKey?: string
    imagesSupport?: boolean
    skillsSupport?: boolean
    agent?: string
    renderContent?: (hook: ReturnType<typeof useMobileStructuredAgentSession>) => ReactNode
  }): ReactNode {
    state.bottomText = useMobileNativeChatDraft('original-bottom')
    state.hook = useMobileStructuredAgentSession({
      client: transport,
      sessionId,
      sourceIdentity: 'host-a',
      enabled,
      connected,
      agent,
      hostSupport:
        editSupport === null
          ? null
          : {
              ...CAPABLE,
              sendSkills: true,
              queuedMessages: false,
              queuedMessageImageEdit: imagesSupport,
              queuedMessageSkillsEdit: skillsSupport,
              queuedMessageEdit: editSupport
            },
      composerScopeKey,
      appendComposerText: append,
      onSendError: error,
      onQueuedEditNotice: notice,
      onActionResolved: resolved
    })
    state.menu = useMobileNativeChatComposerMenu({
      value: state.hook.queued.editor?.text ?? '',
      onChangeText: (text) => state.hook?.queued.editor?.change(text),
      agent,
      structuredCatalog: {
        reported: [{ name: 'review', kind: 'skill', path: '/B/SKILL.md' }],
        conversationCommands: []
      },
      filePaths: [],
      focusField: () => {},
      editing: true,
      // Mirrors the real composer: the menu hands over its row; the draft keeps name and path.
      onPickSkill: ({ token, path }) => {
        const key = state.hook?.queued.editor?.scopeKey
        if (key && path) {
          updateMobileNativeChatDraftInputs(key, (before) => ({
            ...before,
            skills: [{ name: token.slice(1), path }]
          }))
        }
      }
    })
    return renderContent?.(state.hook) ?? null
  }
  function requestedFingerprint(message: AgentSessionQueuedMessage) {
    const params = sendRequest.mock.calls.findLast(
      ([method]) => method === 'agentSession.queuedMessageUpdate'
    )?.[1]
    const fields = QueuedMessageUpdateParams.parse(params)
    const edited = queuedMessageWithEdit(message.body, fields)
    if (!edited.ok) {
      throw new Error(edited.reason)
    }
    return agentSessionSendBodyFingerprint(SESSION_ID, edited.body)
  }
  async function mount(
    message: AgentSessionQueuedMessage,
    editSupport: boolean | null = true,
    agent = 'codex',
    sessionId = SESSION_ID
  ) {
    vi.clearAllMocks()
    resetMobileNativeChatDraftInputsForTests()
    resetMobileNativeChatDraftStoreForTests()
    sendRequest.mockImplementation(async (method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? mutationOk({
            status: 'updated',
            messageId: message.messageId,
            fingerprint: requestedFingerprint(message)
          })
        : readOrHoldReply(method, params)
    )
    await act(async () => {
      state.renderer = create(createElement(Harness, { editSupport, agent, sessionId }))
    })
    const snapshot = snapshotEvent({ queuedMessages: [message], runningTurn: true })
    act(() => state.listener?.({ ...snapshot, sessionId, page: { ...snapshot.page, sessionId } }))
    if (editSupport !== null) {
      await act(async () => {
        expect(await state.hook!.queued.edit!(message.messageId)).toBe(true)
      })
    }
  }
  afterEach(async () => {
    await act(async () => state.renderer?.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  return {
    state,
    Harness,
    mount,
    client,
    sendRequest,
    append,
    error,
    notice,
    resolved,
    requestedFingerprint
  }
}

export function registerQueuedCanonicalInputTest({
  state,
  mount,
  sendRequest
}: ReturnType<typeof mobileQueuedEditHarness>): void {
  it('opens full canonical task input and publishes a changed Save as user-authored raw input', async () => {
    const prefix = 'You are working inside Orca, a multi-agent IDE.\n=== TASK ===\n'
    const message = queuedDraft({
      messageId: 'task',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: `${prefix}  Task 🐋 [Image #1]  ` },
          { type: 'image-ref', path: '/host/shot.png' }
        ],
        from: {
          kind: 'agent',
          senders: [
            {
              party: { address: 'term_coord', terminalHandle: 'term_coord', orcaSessionId: null },
              name: 'Coordinator',
              relation: 'coordinator'
            }
          ],
          orchestration: { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
        }
      }
    })
    await mount(message)
    expect(state.hook!.queued.cards[0]).toMatchObject({
      line: '  Task 🐋',
      attribution: 'From Coordinator'
    })
    expect(state.hook!.queued.cards[0].images).toHaveLength(1)
    expect(state.hook!.queued.editor!.text).toBe(`${prefix}  Task 🐋 [Image #1]  `)
    await act(async () => {
      expect(await state.hook!.queued.editor!.save()).toBe(true)
    })
    expect(
      sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageUpdate')
    ).toBe(false)
    expect(state.hook!.queued.cards[0]).toMatchObject({
      line: '  Task 🐋',
      attribution: 'From Coordinator'
    })
    await act(async () => {
      await state.hook!.queued.edit!('task')
    })
    act(() => state.hook!.queued.editor!.change(`${prefix}Edited`))
    await act(async () => {
      expect(await state.hook!.queued.editor!.save()).toBe(true)
    })
    const update = sendRequest.mock.calls.find(
      ([method]) => method === 'agentSession.queuedMessageUpdate'
    )
    expect(fieldsOf(update?.[1]).text).toBe(`${prefix}Edited`)
    // The current host commits changed content without the original agent attribution.
    const { from: _sender, ...userBody } = withText(message.body, `${prefix}Edited`)
    const saved: typeof message = { ...message, body: userBody }
    act(() => state.listener?.(batchEvent([saved])))
    const [savedCard] = state.hook!.queued.cards
    expect(savedCard).toMatchObject({
      line: `${prefix}Edited`,
      attribution: null
    })
    await act(async () => {
      await state.hook!.queued.edit!('task')
    })
    expect(state.hook!.queued.editor!.text).toBe(`${prefix}Edited`)
    await act(async () => state.hook!.queued.editor!.cancel())
  })
}
