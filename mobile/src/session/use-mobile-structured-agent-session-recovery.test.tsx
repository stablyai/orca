// Exercise real recovery publication and normal Resume through the current phone controller and tray.

import { createElement } from 'react'
import { STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS } from '../../../src/shared/structured-agent-session-coalescer'
import { useMobileNativeChatComposerTray } from './native-chat/composer/use-mobile-native-chat-composer-tray'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionHistoryResult,
  AgentSessionMutationEnvelope
} from '../../../src/shared/agent-session-wire'
import { QueuedMessagesResumeParams } from '../../../src/shared/rpc-contract/structured-agent-session-params'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  CAPABLE,
  SESSION_ID,
  acceptedSubmission,
  batchEvent,
  fieldsOf,
  mutationOk,
  ok,
  queuedDraft,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

// Run the real host publisher/action without pulling Node ambient declarations into the phone compiler.
const { createQueuedMessageTestRig, QUEUED_RIG_CALLER } = await vi.importActual<{
  QUEUED_RIG_CALLER: { callerKey: string }
  createQueuedMessageTestRig: (options: { restartable: true }) => Promise<{
    workingSend: () => Promise<string>
    send: (text: string, delivery?: 'queue-if-active') => { id: string; result: Promise<unknown> }
    submission: (id: string) => Promise<{ handedOverAt?: number } | undefined>
    stop: () => Promise<unknown>
    dispose: () => Promise<void>
    host: {
      history: (request: {
        sessionId: string
        direction: 'tail'
      }) => Promise<AgentSessionHistoryResult>
      queuedMessagesResume: (
        caller: { callerKey: string },
        params: { envelope: AgentSessionMutationEnvelope }
      ) => Promise<unknown>
    }
  }>
}>(
  '../../../src/main/native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
)

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

vi.mock('../components/DragReorderList', () => ({ DragReorderList: 'DragReorderList' }))
vi.mock('./MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react')
  return {
    default: { ScrollView: 'ScrollView' },
    useAnimatedRef: () => useRef(null),
    useSharedValue: (value: unknown) => useRef({ value }).current
  }
})

vi.mock('react-native', () => ({
  Dimensions: { get: () => ({ width: 430, height: 900 }) },
  useWindowDimensions: () => ({ fontScale: 1 }),
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Activity: 'Activity',
  AlertCircle: 'AlertCircle',
  Bot: 'Bot',
  ChevronDown: 'ChevronDown',
  CircleHelp: 'CircleHelp',
  SquareTerminal: 'SquareTerminal',
  Workflow: 'Workflow',
  CornerDownRight: 'CornerDownRight',
  ListEnd: 'ListEnd',
  MoreHorizontal: 'MoreHorizontal',
  Pause: 'Pause',
  Pencil: 'Pencil',
  Play: 'Play',
  Send: 'Send',
  Trash2: 'Trash2'
}))

vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../components/AgentStateDot', () => ({
  AGENT_WORKING_COLOR: '#eab308',
  AgentStateDot: 'AgentStateDot'
}))
vi.mock('../hooks/use-now', () => ({ useNow: () => 100_000 }))

describe('current recovery publication and normal Resume', () => {
  let showTray = false
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  let stored: Map<string, string>
  const onSendError = vi.fn()
  const appendText = vi.fn((_text: string) => true)
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, onData) => {
    listener = onData
    return vi.fn()
  })
  const client: RpcClient = {
    sendRequest,
    subscribe,
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }

  function Harness({
    hostSupport,
    sessionId = SESSION_ID
  }: {
    hostSupport: StructuredAgentSessionHostSupport
    sessionId?: string
  }): React.JSX.Element | null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId,
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'claude',
      hostSupport,
      appendComposerText: appendText,
      onSendError
    })
    const tray = useMobileNativeChatComposerTray({
      queued: {
        sessionKey: hook.queued.sessionKey,
        cards: hook.queued.cards,
        pause: hook.queued.pause,
        onResume: hook.queued.resume,
        onSend: hook.queued.send,
        onDelete: hook.queued.delete,
        onEdit: hook.queued.edit,
        onMove: hook.queued.move
      },
      backgroundTasks: null
    })
    return showTray ? createElement('View', null, tray.content) : null
  }

  async function mountSession(
    hostSupport: StructuredAgentSessionHostSupport,
    event: AgentSessionSubscribeEvent = snapshotEvent(),
    sessionId?: string
  ): Promise<void> {
    act(() => {
      renderer = create(
        createElement(Harness, { hostSupport, ...(sessionId ? { sessionId } : {}) })
      )
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(event))
  }

  function unmountSession(): void {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    listener = null
  }

  function calls(method: string) {
    return sendRequest.mock.calls.filter(([calledMethod]) => calledMethod === method)
  }

  function requestOf(method: string, index = 0) {
    const params = fieldsOf(calls(method)[index]?.[1])
    return { params, envelope: fieldsOf(params.envelope) }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    showTray = false

    stored = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      stored.delete(key)
    })
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    unmountSession()
  })

  describe('saved independent hold through feed, controller, tray and normal header', () => {
    const r = queuedDraft({
      messageId: 'R',
      position: 0,
      state: 'waiting',
      paused: true
    })
    const w1 = queuedDraft({ messageId: 'W1', position: 1 })
    const q = queuedDraft({
      messageId: 'Q',
      position: 2,
      state: 'returned',
      returnedReason: 'ordinary refusal'
    })
    const w2 = queuedDraft({ messageId: 'W2', position: 3 })
    const header = () =>
      renderer!.root.findAllByProps({ accessibilityLabel: 'Resume sending the queued messages' })

    it.each([1, 2])(
      'keeps %i uncertain originals ordinary while normal Resume targets only the queue',
      async (count) => {
        showTray = true
        const rig = await createQueuedMessageTestRig({ restartable: true })
        try {
          await rig.workingSend()
          await rig.send('W1', 'queue-if-active').result
          await rig.send('W2', 'queue-if-active').result
          await rig.stop()
          if (count === 2) {
            const sent = rig.send('second unknown original')
            await sent.result
            await vi.waitFor(async () =>
              expect((await rig.submission(sent.id))?.handedOverAt).toBeDefined()
            )
            await rig.stop()
          }
          let snapshot: AgentSessionSubscribeEvent | undefined
          await vi.waitFor(async () => {
            const result = await rig.host.history({ sessionId: 'session-alpha', direction: 'tail' })
            expect(result.page.queuedMessages).toHaveLength(2)
            snapshot = {
              type: 'snapshot',
              sessionId: result.page.sessionId,
              page: result.page,
              fence: result.page.fence ?? 1,
              queuedMessages: result.page.queuedMessages,
              queuePause: result.page.queuePause,
              nextQueuedMessageId: result.page.nextQueuedMessageId
            }
          })
          if (!snapshot) {
            throw new Error('missing host snapshot')
          }
          sendRequest.mockImplementation(async (method, params) =>
            method === 'agentSession.queuedMessagesResume'
              ? ok(
                  await rig.host.queuedMessagesResume(
                    QUEUED_RIG_CALLER,
                    QueuedMessagesResumeParams.parse(params)
                  )
                )
              : ok({})
          )
          await mountSession(CAPABLE, snapshot, 'session-alpha')
          expect(hook!.queued.cards).toHaveLength(2)
          expect(hook!.queued.cards.map((c) => c.caption)).toEqual([null, null])
          expect(header()).toHaveLength(1)
          await act(async () => header()[0]!.props.onPress())
          expect(calls('agentSession.queuedMessagesResume')).toHaveLength(1)
          expect(Object.keys(requestOf('agentSession.queuedMessagesResume').params)).toEqual([
            'envelope'
          ])
          expect(calls('agentSession.queuedMessageSend')).toHaveLength(0)
          const result = await rig.host.history({ sessionId: 'session-alpha', direction: 'tail' })
          expect(result.page.queuePause).toBeNull()
          unmountSession()
        } finally {
          await rig.dispose()
        }
      }
    )

    it('retains the published barrier across a withheld catch-up tuple and bounds/old-host/no-pause cases', async () => {
      showTray = true
      await mountSession(CAPABLE, snapshotEvent({ queuedMessages: [r, w1, q, w2] }))
      act(() => listener?.(batchEvent([r, w1, q, w2], [], { reason: 'stopped' })))
      expect(header()).toHaveLength(1)
      vi.useFakeTimers()
      act(() => {
        listener?.(batchEvent(undefined, [acceptedSubmission('handoff-W1', 'W1')]))
        vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
      })
      expect(hook!.queued.cards.map((c) => c.messageId)).toEqual(['R', 'Q', 'W2'])
      expect(hook!.queued.cards.at(-1)?.caption).toBe('Waiting — a message ahead needs attention')
      expect(header()).toHaveLength(0)
      act(() =>
        listener?.(
          batchEvent(
            [r, w1, queuedDraft({ messageId: 'W0', position: 1.5 }), q, w2],
            [acceptedSubmission('handoff-W1', 'W1')],
            { reason: 'stopped' }
          )
        )
      )
      expect(header()).toHaveLength(1)
      for (const queuedMessages of [
        [q, w2],
        [r],
        [],
        [queuedDraft({ messageId: 'P', paused: true })],
        [{ ...r, state: 'returned' as const, paused: undefined }, w2]
      ]) {
        act(() => listener?.(batchEvent(queuedMessages, [], { reason: 'stopped' })))
        expect(header()).toHaveLength(0)
      }
      act(() =>
        listener?.(
          batchEvent([w1], [acceptedSubmission('handoff-W1', 'W1')], { reason: 'stopped' })
        )
      )
      expect(hook!.queued.cards).toEqual([])
      expect(header()).toHaveLength(0)
      act(() => listener?.(snapshotEvent({ queuedMessages: [w1, { ...r, position: 2 }, w2] })))
      expect(hook!.queued.cards.map((c) => c.caption)).toEqual([null, 'Paused', null])
      expect(header()).toHaveLength(0)
    })

    it.each([100, 1000])(
      'bounds actual publication/feed/controller join work at N=%i',
      async (n) => {
        await mountSession({ ...CAPABLE, queuedMessageReorder: true })
        vi.useFakeTimers()
        let reads = 0
        const messages = Array.from({ length: n }, (_, i) => {
          const message = queuedDraft({ messageId: `W${i}`, position: i })
          return {
            ...message,
            get messageId() {
              reads++
              return message.messageId
            }
          }
        })
        act(() => listener?.(batchEvent(messages, [], { reason: 'stopped' })))
        expect(hook!.queued.cards).toHaveLength(n)
        expect(hook!.queued.pause).toEqual({ reason: 'stopped' })
        expect(reads).toBeGreaterThanOrEqual(n)
        expect(reads).toBeLessThanOrEqual(20 * n)
        const before = reads
        act(() => {
          listener?.(
            batchEvent(undefined, [acceptedSubmission('handoff-W0', 'W0')], { reason: 'stopped' })
          )
          vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
        })
        expect(hook!.queued.cards).toHaveLength(n - 1)
        expect(hook!.queued.cards.some((card) => card.messageId === 'W0')).toBe(false)
        expect(reads - before).toBeGreaterThanOrEqual(n)
        expect(reads - before).toBeLessThanOrEqual(20 * n)
      }
    )

    it('intersects a pending raw preview with fresh visibility and facts, retaining hidden-anchor order and refusal rollback', async () => {
      await mountSession(
        { ...CAPABLE, queuedMessageReorder: true },
        snapshotEvent({ queuedMessages: [w1, q, w2] })
      )
      act(() => listener?.(batchEvent([w1, q, w2], [], { reason: 'stopped' })))
      const reply = Promise.withResolvers<RpcResponse>()
      sendRequest.mockImplementation(() => reply.promise)
      let moving!: Promise<boolean>
      act(() => {
        moving = hook!.queued.move!({ movedId: 'W2', beforeId: 'W1' })
      })
      expect(hook!.queued.cards.map((c) => c.messageId)).toEqual(['W2', 'W1', 'Q'])
      expect(hook!.queued.cards[0]).toMatchObject({
        caption: 'Waiting — a message ahead needs attention'
      })
      vi.useFakeTimers()
      act(() => {
        listener?.(batchEvent(undefined, [acceptedSubmission('handoff-W1', 'W1')]))
        vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
      })
      expect(hook!.queued.cards.map((c) => c.messageId)).toEqual(['W2', 'Q'])
      expect(hook!.queued.pause).toBeNull()
      expect(requestOf('agentSession.queuedMessageMove').params).toMatchObject({
        messageId: 'W2',
        beforeMessageId: 'W1'
      })
      act(() => {
        listener?.(batchEvent(undefined, [acceptedSubmission('handoff-W2', 'W2')]))
        vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
      })
      expect(hook!.queued.cards.map((c) => c.messageId)).toEqual(['Q'])
      await act(async () => {
        reply.resolve(mutationOk({ messageId: 'W2', status: 'stale' }))
        expect(await moving).toBe(false)
      })
      expect(hook!.queued.cards.map((c) => c.messageId)).toEqual(['Q'])
      expect(onSendError).toHaveBeenCalledTimes(1)
    })

    it('reprojects command busy state during a preview and supersedes it on a fresh own-hold publication or scope', async () => {
      const command = queuedDraft({
        messageId: 'C',
        position: 2,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/compact' }],
          command: { name: 'compact' }
        }
      })
      const returned = queuedDraft({
        messageId: 'auth',
        position: 3,
        state: 'returned',
        returnedRejection: { kind: 'notSignedIn' }
      })
      await mountSession(
        { ...CAPABLE, queuedMessageReorder: true },
        snapshotEvent({ queuedMessages: [w1, command, returned] })
      )
      const reply = Promise.withResolvers<RpcResponse>()
      sendRequest.mockImplementation(() => reply.promise)
      let moving!: Promise<boolean>
      act(() => {
        moving = hook!.queued.move!({ movedId: 'C', beforeId: 'W1' })
      })
      expect(hook!.queued.cards[0]).not.toHaveProperty('waitsForAgent')
      expect(hook!.queued.cards.at(-1)?.caption).toContain('claude auth login')
      const failure: AgentJournalRenderItem = {
        itemId: 'auth-failure',
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'status',
          ...agentSessionFailureWords(
            { kind: 'notSignedIn' },
            { surface: 'row', agentName: 'Claude' }
          )
        }
      }
      const running = [...snapshotEvent({ runningTurn: true }).page.items, failure]
      const event = batchEvent()
      if (event.type !== 'batch') {
        throw new Error('expected batch')
      }
      act(() => listener?.({ ...event, batch: { ...event.batch, items: running } }))
      expect(hook!.queued.cards[0]).toMatchObject({ messageId: 'C', waitsForAgent: true })
      expect(hook!.queued.cards.at(-1)?.caption).toBe('Your message was not sent.')
      act(() =>
        listener?.(
          batchEvent([{ ...w1, paused: true }, command, returned], [], { reason: 'stopped' })
        )
      )
      expect(hook!.queued.cards.map((c) => c.messageId)).toEqual(['W1', 'C', 'auth'])
      expect(hook!.queued.cards[0]).toMatchObject({ hold: 'paused', caption: 'Paused' })
      await act(async () =>
        renderer!.update(
          createElement(Harness, {
            hostSupport: { ...CAPABLE, queuedMessageReorder: true },
            sessionId: 'other-session'
          })
        )
      )
      expect(hook!.queued.cards).toEqual([])
      await act(async () => {
        reply.resolve(mutationOk({ messageId: 'C', status: 'stale' }))
        await moving
      })
      expect(hook!.queued.cards).toEqual([])
      expect(onSendError).not.toHaveBeenCalled()
    })
  })
})
