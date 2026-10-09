// The mid-turn queue on mobile: `delivery` rides only capability-gated sends,
// published drafts render as cards (never optimistic bubbles), and card actions
// map to the queued-message RPCs. Stop never touches the queue — its cards
// stay on the host under a queue-level pause, lifted by Resume, and no text
// travels back over the wire.
// Edit copies the card's shown text into the composer before its delete
// leaves, so no RPC outcome can lose it. An incapable host gets exactly
// today's requests.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { agentSessionVisibleFailureFacts } from '../../../src/shared/agent-session-visible-failures'
import type * as AgentSessionVisibleFailures from '../../../src/shared/agent-session-visible-failures'

vi.mock('../../../src/shared/agent-session-visible-failures', async (importOriginal) => {
  const original = await importOriginal<typeof AgentSessionVisibleFailures>()
  return {
    ...original,
    agentSessionVisibleFailureFacts: vi.fn(original.agentSessionVisibleFailureFacts)
  }
})
import {
  CAPABLE,
  LEGACY,
  SESSION_ID,
  acceptedSubmission,
  batchEvent,
  fieldsOf,
  mutationOk,
  ok,
  queuedDraft,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

describe('mobile structured queued messages', () => {
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
  }): null {
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
    return null
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

  /** Params of the `index`th `method` request, and its envelope. */
  function requestOf(method: string, index = 0) {
    const params = fieldsOf(calls(method)[index]?.[1])
    return { params, envelope: fieldsOf(params.envelope) }
  }

  /** Global invocation order of the first `method` request, for cross-spy ordering. */
  function callOrderOf(method: string): number | undefined {
    return sendRequest.mock.invocationCallOrder.find(
      (_, index) => sendRequest.mock.calls[index]?.[0] === method
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()

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

  describe('capability-gated delivery', () => {
    it('scans failure facts only when a returned card needs them', async () => {
      await mountSession(CAPABLE)
      act(() => listener?.(snapshotEvent({ runningTurn: true })))
      expect(agentSessionVisibleFailureFacts).not.toHaveBeenCalled()
      act(() =>
        listener?.(
          snapshotEvent({
            queuedMessages: [
              queuedDraft({
                messageId: 'returned',
                state: 'returned',
                returnedRejection: { kind: 'notSignedIn' }
              })
            ]
          })
        )
      )
      expect(agentSessionVisibleFailureFacts).toHaveBeenCalledTimes(1)
      expect(hook!.queued.cards[0]?.caption).toContain('claude auth login')
    })
    it('sends delivery: queue-if-active — fingerprint included — only on a capable host', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.send') {
          return mutationOk({
            clientMessageId: 'client-1',
            queued: { messageId: 'client-1', position: 1, state: 'waiting' }
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect((await hook!.sendWithOutcome('queue me')).outcome).toBe('queued')
      })
      const { params, envelope } = requestOf('agentSession.send')
      expect(params.delivery).toBe('queue-if-active')
      expect(envelope.payloadFingerprint).toBe(
        structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION_ID,
          fields: { body: params.body, delivery: 'queue-if-active' }
        })
      )
      expect(asyncStorage.setItem).not.toHaveBeenCalled()
    })

    it('keeps today’s request exactly against an incapable host', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.send') {
          return mutationOk({
            clientMessageId: 'client-1',
            submission: {
              clientMessageId: 'client-1',
              fence: 3,
              payloadFingerprint: 'fp',
              dispatchState: 'accepted',
              providerItemId: null,
              reason: null,
              submittedAt: 10,
              resolvedAt: 10
            }
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(LEGACY)
      await act(async () => {
        expect((await hook!.sendWithOutcome('plain send')).outcome).toBe('accepted')
      })
      const { params, envelope } = requestOf('agentSession.send')
      expect('delivery' in params).toBe(false)
      expect(envelope.payloadFingerprint).toBe(
        structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION_ID,
          fields: { body: params.body }
        })
      )
    })

    it('a new send follows the current host capability after acknowledgement loss', async () => {
      let attempts = 0
      sendRequest.mockImplementation(async (method, params) => {
        if (method !== 'agentSession.send') {
          return ok({ models: [], current: {} })
        }
        if (++attempts === 1) {
          throw markRpcDeliveryUnknown(new Error('Connection closed'))
        }
        const id = String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
        return mutationOk({ clientMessageId: id, submission: acceptedSubmission(id) })
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect((await hook!.sendWithOutcome('again')).outcome).toBe('unknown')
      })
      unmountSession()
      await mountSession(LEGACY)
      await act(async () => {
        expect((await hook!.sendWithOutcome('again')).outcome).toBe('accepted')
      })
      const first = requestOf('agentSession.send', 0)
      const second = requestOf('agentSession.send', 1)
      expect(first.params.delivery).toBe('queue-if-active')
      expect('delivery' in second.params).toBe(false)
      expect(second.envelope.clientOperationId).not.toBe(first.envelope.clientOperationId)
    })
  })

  it('an ack-lost queued send never absorbs the next identical message', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method, params) => {
      if (method !== 'agentSession.send') {
        return ok({ models: [], current: {} })
      }
      if (++attempts === 1) {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      const id = String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
      return mutationOk({
        clientMessageId: id,
        queued: { messageId: id, position: 1, state: 'waiting' }
      })
    })
    await mountSession(CAPABLE, snapshotEvent({ runningTurn: true }))
    await act(async () => {
      expect((await hook!.sendWithOutcome('held')).outcome).toBe('unknown')
    })
    const firstId = String(requestOf('agentSession.send').envelope.clientOperationId)
    act(() => listener?.(batchEvent([queuedDraft({ messageId: firstId })])))
    await act(async () => {
      expect((await hook!.sendWithOutcome('held')).outcome).toBe('queued')
    })
    expect(attempts).toBe(2)
    expect(requestOf('agentSession.send', 1).envelope.clientOperationId).not.toBe(firstId)
  })

  describe('cards from the published list', () => {
    it('renders published drafts as cards and follows later frames', async () => {
      await mountSession(
        CAPABLE,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      expect(hook!.queued.cards).toEqual([
        {
          messageId: 'draft-1',
          text: 'text of draft-1',
          state: 'waiting',
          paused: false,
          needsAttention: false,
          caption: null,
          attribution: null
        }
      ])
      // A frame without the field leaves the list alone; null empties it.
      act(() => listener?.(batchEvent()))
      expect(hook!.queued.cards).toHaveLength(1)
      act(() => listener?.(batchEvent(null)))
      expect(hook!.queued.cards).toEqual([])
    })

    it('hides a waiting card once a submission names it as its hand-off, as the desktop does', async () => {
      await mountSession(
        CAPABLE,
        snapshotEvent({
          queuedMessages: [
            queuedDraft({ messageId: 'drained' }),
            queuedDraft({ messageId: 'still-waiting' })
          ],
          submissions: [acceptedSubmission('fresh-hand-off-id', 'drained')]
        })
      )
      expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['still-waiting'])
    })

    it('never hides a card by a direct send that merely shares its id', async () => {
      await mountSession(
        CAPABLE,
        snapshotEvent({
          queuedMessages: [queuedDraft({ messageId: 'same-id' })],
          submissions: [acceptedSubmission('same-id')]
        })
      )
      expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['same-id'])
    })

    // A host that does not queue sends still keeps a message it accepted and never sent across a
    // restart or a close, and publishes it as a card; only queueing a new send is gated.
    it('shows the cards a host that does not queue sends publishes', async () => {
      await mountSession(LEGACY)
      act(() =>
        listener?.(
          batchEvent(
            [
              queuedDraft({ messageId: 'kept-1' }),
              queuedDraft({ messageId: 'behind', position: 2 })
            ],
            [],
            null
          )
        )
      )
      // Plain waiting cards: the host holds them until the chat's next turn, and shows no row.
      expect(hook!.queued.cards.map(({ messageId, caption }) => ({ messageId, caption }))).toEqual([
        { messageId: 'kept-1', caption: null },
        { messageId: 'behind', caption: null }
      ])
      expect(hook!.queued.pause).toBeNull()
    })
  })

  describe('card actions', () => {
    it('Send-now consumes through agentSession.queuedMessageSend', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageSend') {
          return mutationOk({
            clientMessageId: 'draft-1',
            // Every hand-off goes out under a fresh id and names its draft.
            submission: {
              clientMessageId: 'hand-off-1',
              queuedMessageId: 'draft-1',
              fence: 3,
              payloadFingerprint: 'fp',
              dispatchState: 'pending',
              providerItemId: null,
              reason: null,
              submittedAt: 10,
              resolvedAt: null
            }
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.queued.send('draft-1')).toBe(true)
      })
      expect(requestOf('agentSession.queuedMessageSend').params.messageId).toBe('draft-1')
    })

    it('each press of a card action carries its own id, even while an earlier press is unanswered', async () => {
      const held = Promise.withResolvers<RpcResponse>()
      sendRequest.mockImplementation(async (method) =>
        method === 'agentSession.queuedMessageSend' || method === 'agentSession.queuedMessageDelete'
          ? held.promise
          : method === 'agentSession.options'
            ? ok({ models: [], current: {} })
            : ok({})
      )
      await mountSession(CAPABLE)
      const presses: Promise<boolean>[] = []
      act(() => {
        presses.push(hook!.queued.send('draft-1'), hook!.queued.send('draft-1'))
        presses.push(hook!.queued.delete('draft-1'), hook!.queued.delete('draft-1'))
      })
      await act(async () => {
        held.resolve(ok({}))
        await Promise.all(presses)
      })
      for (const method of ['agentSession.queuedMessageSend', 'agentSession.queuedMessageDelete']) {
        expect(requestOf(method, 1).envelope.clientOperationId).not.toBe(
          requestOf(method, 0).envelope.clientOperationId
        )
      }
    })

    it('Delete reads the union result: a dispatched draft was already sent', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageDelete') {
          return mutationOk({ deleted: false, messageId: 'draft-1', disposition: 'dispatched' })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.queued.delete('draft-1')).toBe(false)
      })
      expect(onSendError).toHaveBeenCalledWith('This message was already sent.')
    })

    it('Edit copies the card’s shown text into the composer before its delete leaves', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageDelete') {
          return mutationOk({ deleted: true, messageId: 'draft-1' })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(
        CAPABLE,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      await act(async () => {
        expect(await hook!.queued.edit('draft-1')).toBe(true)
      })
      // The copy comes from the card the user is looking at, not from any answer.
      expect(appendText.mock.calls).toEqual([['text of draft-1']])
      // Copy-first: the text was in the composer before the delete RPC left, so
      // no Delete outcome can lose it.
      expect(appendText.mock.invocationCallOrder[0]).toBeLessThan(
        callOrderOf('agentSession.queuedMessageDelete')!
      )
      // A plain delete: only the message id goes out, and nothing durable is written.
      expect(requestOf('agentSession.queuedMessageDelete').params.messageId).toBe('draft-1')
      expect(asyncStorage.setItem).not.toHaveBeenCalled()
    })

    it('Edit keeps the copied text when the delete fails; the card stays beside it', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageDelete') {
          return { id: 'request-1', ok: false, error: { code: 'runtime_error', message: 'boom' } }
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(
        CAPABLE,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      await act(async () => {
        expect(await hook!.queued.edit('draft-1')).toBe(false)
      })
      // The user sees both copies — composer text and the surviving card — and
      // can press Delete again; nothing is lost and nothing is restored twice.
      expect(appendText.mock.calls).toEqual([['text of draft-1']])
      expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['draft-1'])
    })

    it('Edit racing the drain still copies; the user hears it already went out', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageDelete') {
          return mutationOk({ deleted: false, messageId: 'draft-1', disposition: 'dispatched' })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(
        CAPABLE,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      await act(async () => {
        expect(await hook!.queued.edit('draft-1')).toBe(false)
      })
      expect(appendText.mock.calls).toEqual([['text of draft-1']])
      // The copy is still in the composer: say so, or it reads as unsent and goes out twice.
      expect(onSendError).toHaveBeenCalledWith('Already sent — your text is still in the composer.')
    })

    it('Edit that copied nothing deletes nothing and does not report a copy', async () => {
      sendRequest.mockImplementation(async (method) =>
        method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      )
      await mountSession(
        CAPABLE,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      appendText.mockReturnValueOnce(false)
      const onCopied = vi.fn()
      await act(async () => {
        expect(await hook!.queued.edit('draft-1', onCopied)).toBe(false)
      })
      expect(appendText.mock.calls).toEqual([['text of draft-1']])
      expect(onCopied).not.toHaveBeenCalled()
      expect(callOrderOf('agentSession.queuedMessageDelete')).toBeUndefined()
      expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['draft-1'])
    })
  })

  describe('Stop leaves the queue alone', () => {
    it('a capable Stop is a plain cancel; the cards stay and the queue reads as paused', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.cancel') {
          return mutationOk({ cancelled: true, turnId: 'turn-1' })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(
        CAPABLE,
        snapshotEvent({
          runningTurn: true,
          queuedMessages: [queuedDraft({ messageId: 'draft-1' })]
        })
      )
      await act(async () => {
        expect(await hook!.cancelPrompt()).toBe(true)
      })
      // Exactly today's cancel: no withdrawal ask, no text owed back, nothing durable.
      const { params } = requestOf('agentSession.cancel')
      expect(Object.keys(params).sort()).toEqual(['envelope', 'turnId'])
      expect(params.turnId).toBe('turn-1')
      expect(appendText).not.toHaveBeenCalled()
      expect(asyncStorage.setItem).not.toHaveBeenCalled()
      expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['draft-1'])
      // The host's pause is the queue's, published beside the list; the card itself is not held.
      act(() =>
        listener?.(batchEvent([queuedDraft({ messageId: 'draft-1' })], [], { reason: 'stopped' }))
      )
      expect(hook!.queued.pause).toEqual({ reason: 'stopped' })
      expect(hook!.queued.cards[0]).toMatchObject({
        messageId: 'draft-1',
        paused: false,
        caption: null
      })
      // A frame without the list leaves the pause alone; one that publishes the list states it.
      act(() => listener?.(batchEvent()))
      expect(hook!.queued.pause).toEqual({ reason: 'stopped' })
      act(() => listener?.(batchEvent([queuedDraft({ messageId: 'draft-1' })], [], null)))
      expect(hook!.queued.pause).toBeNull()
    })

    it('shows no pause while Resume would send nothing: only returned, blocked or failed cards', async () => {
      const returned = queuedDraft({ messageId: 'r', state: 'returned', returnedReason: 'refused' })
      const behind = queuedDraft({ messageId: 'b', position: 2 })
      const failed = queuedDraft({ messageId: 'f', paused: true, pausedReason: 'send_failed' })
      await mountSession(CAPABLE, snapshotEvent({ queuedMessages: [] }))
      for (const list of [[returned], [returned, behind], [failed]]) {
        act(() => listener?.(batchEvent(list, [], { reason: 'stopped' })))
        expect(hook!.queued.pause).toBeNull()
      }
      act(() => listener?.(batchEvent([failed, behind], [], { reason: 'stopped' })))
      expect(hook!.queued.pause).toEqual({ reason: 'stopped' })
    })

    it('Resume lifts the pause through its RPC, and a refusal reaches the error banner', async () => {
      let refuse = false
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessagesResume') {
          return refuse
            ? ok({
                ok: false,
                refusal: { code: 'agent_session_operation_invalid', message: 'Could not resume.' }
              })
            : mutationOk({ resumed: true })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(
        CAPABLE,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      await act(async () => {
        expect(await hook!.queued.resume()).toBe(true)
      })
      expect(Object.keys(requestOf('agentSession.queuedMessagesResume').params)).toEqual([
        'envelope'
      ])
      refuse = true
      await act(async () => {
        expect(await hook!.queued.resume()).toBe(false)
      })
      expect(onSendError).toHaveBeenCalledWith(expect.any(String))
    })

    it('an incapable Stop is exactly today’s cancel', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.cancel') {
          return mutationOk({ cancelled: true, turnId: 'turn-1' })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(LEGACY, snapshotEvent({ runningTurn: true }))
      await act(async () => {
        expect(await hook!.cancelPrompt()).toBe(true)
      })
      const { params } = requestOf('agentSession.cancel')
      expect(Object.keys(params).sort()).toEqual(['envelope', 'turnId'])
      expect(asyncStorage.setItem).not.toHaveBeenCalled()
    })
  })
})
