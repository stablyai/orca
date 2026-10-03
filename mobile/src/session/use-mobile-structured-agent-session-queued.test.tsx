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
import { resetMobileStructuredSendOperationJournalForTests } from './mobile-structured-send-operation-journal'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
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
    resetMobileStructuredSendOperationJournalForTests()
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
        expect(await hook!.sendWithOutcome('queue me')).toBe('queued')
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
      // Spent at `queued`: the durable send-operation entry is released.
      await vi.waitFor(() =>
        expect(stored.has('orca:mobileStructuredSendOperations:v1')).toBe(false)
      )
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
        expect(await hook!.sendWithOutcome('plain send')).toBe('accepted')
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

    it('replays an ack-lost delivery send under one id and the delivery it was sent with', async () => {
      let attempts = 0
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.send') {
          attempts += 1
          throw markRpcDeliveryUnknown(new Error('Connection closed'))
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.sendWithOutcome('retry me')).toBe('unknown')
      })
      unmountSession()
      // The capability probe has not answered after the reload, but the recorded
      // operation must replay bit-for-bit — content-derived key, same id, same
      // delivery field — or the host would refuse it as a fingerprint conflict.
      await mountSession(LEGACY)
      await act(async () => {
        expect(await hook!.sendWithOutcome('retry me')).toBe('unknown')
      })
      expect(attempts).toBe(2)
      const first = requestOf('agentSession.send', 0)
      const second = requestOf('agentSession.send', 1)
      expect(second.params.delivery).toBe('queue-if-active')
      expect(second.envelope.clientOperationId).toBe(first.envelope.clientOperationId)
      // Nothing new is persisted: an older build still reads the send journal.
      const journal = stored.get('orca:mobileStructuredSendOperations:v1') ?? ''
      expect(journal).not.toContain('delivery')
    })

    it('retires an ack-lost delivery send an older host refuses, so the next send goes out plain', async () => {
      const journalKey = 'orca:mobileStructuredSendOperations:v1'
      let attempts = 0
      sendRequest.mockImplementation(async (method, params) => {
        if (method === 'agentSession.send') {
          attempts += 1
          if (attempts <= 2) {
            throw markRpcDeliveryUnknown(new Error('Connection closed'))
          }
          // The downgraded host's strict schema turns `delivery` away before running anything.
          if ('delivery' in fieldsOf(params)) {
            return {
              id: 'request-1',
              ok: false,
              error: { code: 'invalid_argument', message: 'Unrecognized key: "delivery"' }
            }
          }
          return mutationOk({
            clientMessageId: 'client-plain',
            submission: {
              clientMessageId: 'client-plain',
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
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.sendWithOutcome('downgraded')).toBe('unknown')
      })
      unmountSession()
      await mountSession(LEGACY)
      // A lost answer is still doubt: the replay keeps the id and its delivery.
      await act(async () => {
        expect(await hook!.sendWithOutcome('downgraded')).toBe('unknown')
      })
      const first = requestOf('agentSession.send', 0)
      expect(requestOf('agentSession.send', 1).envelope.clientOperationId).toBe(
        first.envelope.clientOperationId
      )
      expect(stored.get(journalKey)).toContain(String(first.envelope.clientOperationId))
      // The host answering that it cannot take the request retires the entry, once.
      await act(async () => {
        expect(await hook!.sendWithOutcome('downgraded')).toBe('rejected')
      })
      const refused = requestOf('agentSession.send', 2)
      expect(refused.params.delivery).toBe('queue-if-active')
      expect(refused.envelope.clientOperationId).toBe(first.envelope.clientOperationId)
      expect(onSendError).toHaveBeenCalledTimes(1)
      await act(async () => {
        expect(await hook!.sendWithOutcome('downgraded')).toBe('accepted')
      })
      const plain = requestOf('agentSession.send', 3)
      expect('delivery' in plain.params).toBe(false)
      expect(plain.envelope.clientOperationId).not.toBe(first.envelope.clientOperationId)
      expect(attempts).toBe(4)
    })

    it('keeps an ack-lost send when the host refuses its replay as unauthorized', async () => {
      let attempts = 0
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.send') {
          attempts += 1
          if (attempts === 1) {
            throw markRpcDeliveryUnknown(new Error('Connection closed'))
          }
          // An auth refusal says nothing about whether the first attempt was delivered.
          return {
            id: 'request-1',
            ok: false,
            error: { code: 'unauthorized', message: 'Pairing revoked' }
          }
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.sendWithOutcome('in doubt')).toBe('unknown')
      })
      await act(async () => {
        expect(await hook!.sendWithOutcome('in doubt')).toBe('rejected')
      })
      await act(async () => {
        await hook!.sendWithOutcome('in doubt')
      })
      const first = requestOf('agentSession.send', 0)
      expect(requestOf('agentSession.send', 2).envelope.clientOperationId).toBe(
        first.envelope.clientOperationId
      )
    })
  })

  it('an ack-lost send is spent once the host publishes it as a draft, even one later withdrawn', async () => {
    const journalKey = 'orca:mobileStructuredSendOperations:v1'
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method === 'agentSession.send') {
        attempts += 1
        if (attempts === 1) {
          throw markRpcDeliveryUnknown(new Error('Connection closed'))
        }
        return mutationOk({
          clientMessageId: `client-${attempts}`,
          queued: { messageId: `client-${attempts}`, position: 1, state: 'waiting' }
        })
      }
      return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
    })
    await mountSession(CAPABLE, snapshotEvent({ runningTurn: true }))
    await act(async () => {
      expect(await hook!.sendWithOutcome('held')).toBe('unknown')
    })
    const operationId = String(requestOf('agentSession.send').envelope.clientOperationId)
    expect(stored.get(journalKey)).toContain(operationId)
    // Someone else's draft proves nothing about this send.
    act(() => listener?.(batchEvent([queuedDraft({ messageId: 'other-device' })])))
    await act(async () => {})
    expect(stored.get(journalKey)).toContain(operationId)
    // The host names the draft by this send's operation id: that is its receipt.
    act(() => listener?.(batchEvent([queuedDraft({ messageId: operationId })])))
    await vi.waitFor(() => expect(stored.has(journalKey)).toBe(false))
    // Deleted elsewhere: no submission will ever settle it, and nothing has to.
    act(() => listener?.(batchEvent(null)))
    await act(async () => {
      expect(await hook!.sendWithOutcome('held')).toBe('queued')
    })
    expect(requestOf('agentSession.send', 1).envelope.clientOperationId).not.toBe(operationId)
  })

  it('an identical send whose retained id replays as withdrawn goes out fresh', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method === 'agentSession.send') {
        attempts += 1
        if (attempts === 1) {
          throw markRpcDeliveryUnknown(new Error('Connection closed'))
        }
        const state = attempts === 2 ? 'withdrawn' : 'waiting'
        // A pruned deleted card's receipt names no place in the queue: position 0.
        return mutationOk({
          clientMessageId: `client-${attempts}`,
          queued: {
            messageId: `client-${attempts}`,
            position: state === 'withdrawn' ? 0 : 1,
            state
          }
        })
      }
      return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
    })
    await mountSession(CAPABLE)
    await act(async () => {
      expect(await hook!.sendWithOutcome('again')).toBe('unknown')
    })
    // A Delete spent the ack-lost draft before it reached the agent; typing the
    // same words again is a new message, not a replay to swallow.
    await act(async () => {
      expect(await hook!.sendWithOutcome('again')).toBe('queued')
    })
    expect(attempts).toBe(3)
    const ids = [0, 1, 2].map(
      (index) => requestOf('agentSession.send', index).envelope.clientOperationId
    )
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('a withdrawn replay whose record storage will not clear still goes out fresh, and says so', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method === 'agentSession.send') {
        attempts += 1
        if (attempts === 1) {
          throw markRpcDeliveryUnknown(new Error('Connection closed'))
        }
        const state = attempts === 2 ? 'withdrawn' : 'waiting'
        return mutationOk({
          clientMessageId: `client-${attempts}`,
          queued: { messageId: `client-${attempts}`, position: 1, state }
        })
      }
      return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
    })
    await mountSession(CAPABLE)
    await act(async () => {
      expect(await hook!.sendWithOutcome('again')).toBe('unknown')
    })
    // The retained record cannot be cleared; that must not keep this text from being sent.
    asyncStorage.setItem.mockRejectedValue(new Error('disk full'))
    asyncStorage.removeItem.mockRejectedValue(new Error('disk full'))
    await act(async () => {
      expect(await hook!.sendWithOutcome('again')).toBe('queued')
    })
    expect(attempts).toBe(3)
    const ids = [0, 1, 2].map(
      (index) => requestOf('agentSession.send', index).envelope.clientOperationId
    )
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
    expect(onSendError).toHaveBeenCalledWith(
      "Sent, but this phone couldn't update its record of sent messages."
    )
  })

  describe('a lost answer, then Stop, then the drain under a fresh id', () => {
    const journalKey = 'orca:mobileStructuredSendOperations:v1'
    let attempts = 0
    let lostId = ''

    beforeEach(() => {
      attempts = 0
      lostId = ''
      sendRequest.mockImplementation(async (method, params) => {
        if (method === 'agentSession.send') {
          attempts += 1
          const id = String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
          if (attempts === 1) {
            lostId = id
            throw markRpcDeliveryUnknown(new Error('Connection closed'))
          }
          if (id === lostId) {
            // The replay answers with the hand-off, which names the replayed id as its draft.
            return mutationOk({
              clientMessageId: id,
              submission: acceptedSubmission('fresh-hand-off', id)
            })
          }
          return mutationOk({
            clientMessageId: id,
            queued: { messageId: id, position: 1, state: 'waiting' }
          })
        }
        return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
      })
    })

    it('spends the record once the stream carries the hand-off naming it; a direct send does not', async () => {
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.sendWithOutcome('again')).toBe('unknown')
      })
      expect(stored.get(journalKey)).toContain(lostId)
      // A direct send's submission names no draft, so it settles nothing here.
      act(() => listener?.(batchEvent(undefined, [acceptedSubmission('someone-else')])))
      await act(async () => {})
      expect(stored.get(journalKey)).toContain(lostId)
      // The drain's hand-off went out under a fresh id and names the lost send's draft.
      act(() => listener?.(batchEvent(undefined, [acceptedSubmission('fresh-hand-off', lostId)])))
      await vi.waitFor(() => expect(stored.has(journalKey)).toBe(false))
      await act(async () => {
        expect(await hook!.sendWithOutcome('again')).toBe('queued')
      })
      expect(attempts).toBe(2)
      expect(requestOf('agentSession.send', 1).envelope.clientOperationId).not.toBe(lostId)
    })

    it('spends the record from a replay answered by the hand-off, which no page carries', async () => {
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.sendWithOutcome('again')).toBe('unknown')
      })
      // The host holds that message now; the phone paints no bubble for it. The stream never
      // carries the hand-off, so the answer's link is what spends the record.
      await act(async () => {
        expect(await hook!.sendWithOutcome('again')).toBe('unknown')
      })
      expect(requestOf('agentSession.send', 1).envelope.clientOperationId).toBe(lostId)
      await vi.waitFor(() => expect(stored.has(journalKey)).toBe(false))
      await act(async () => {
        expect(await hook!.sendWithOutcome('again')).toBe('queued')
      })
      expect(requestOf('agentSession.send', 2).envelope.clientOperationId).not.toBe(lostId)
    })
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
          holdsQueue: false,
          caption: null
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

    it('shows no cards from an incapable host even if a list arrives', async () => {
      await mountSession(
        LEGACY,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      expect(hook!.queued.cards).toEqual([])
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
