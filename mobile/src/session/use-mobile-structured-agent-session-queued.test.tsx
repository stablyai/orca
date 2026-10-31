// Test capability-gated queue writes with authoritative cards; Stop preserves host-held drafts and legacy Edit copies before deleting.

import { createElement } from 'react'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
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

function normalReply(method: string): RpcResponse {
  // Queue is the default; explicit OFF is covered below.
  if (method === 'settings.get') {
    return ok({ settings: { nativeChatQueueFollowUps: true } })
  }
  if (method === 'agentSession.options') {
    return ok({ models: [], current: {} })
  }
  if (method === 'agentSession.modelCatalog') {
    return {
      id: 'catalog',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' },
      _meta: { runtimeId: 'runtime-1' }
    }
  }
  return ok({})
}

describe('mobile structured queued messages', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  let preferenceListener: ((value: unknown) => void) | null = null
  let stored: Map<string, string>
  const onSendError = vi.fn()
  const appendText = vi.fn((_text: string) => true)
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, onData) => {
    if (_method === 'agentSession.subscribe') {
      listener = onData
    }
    if (_method === 'runtime.clientEvents.subscribe') {
      preferenceListener = onData
    }
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
    await act(async () => {
      renderer = create(
        createElement(Harness, { hostSupport, ...(sessionId ? { sessionId } : {}) })
      )
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    await act(async () => listener?.(event))
  }

  async function unmountSession(): Promise<void> {
    await act(async () => renderer?.unmount())
    renderer = null
    hook = null
    listener = null
    preferenceListener = null
  }

  function calls(method: string) {
    return sendRequest.mock.calls.filter(([calledMethod]) => calledMethod === method)
  }

  function requestOf(method: string, index = 0) {
    const params = fieldsOf(calls(method)[index]?.[1])
    return { params, envelope: fieldsOf(params.envelope) }
  }

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
    sendRequest.mockImplementation(async (method) => normalReply(method))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await unmountSession()
  })

  it('reverts an optimistic relative move when the host reports a changed queue', async () => {
    const mail = queuedDraft({
      messageId: 'mail',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [],
        from: { kind: 'agent', senders: [], orchestration: null }
      }
    })
    const messages = [mail, queuedDraft({ messageId: 'b', position: 2 })]
    await mountSession(CAPABLE, snapshotEvent({ queuedMessages: messages }))
    expect(hook!.queued.move).toBeUndefined()
    expect(calls('agentSession.queuedMessageMove')).toHaveLength(0)
    await unmountSession()
    await mountSession(
      { ...CAPABLE, queuedMessageReorder: true },
      snapshotEvent({ queuedMessages: messages })
    )
    let finish: (response: RpcResponse) => void = () => {}
    const otherMethods = sendRequest.getMockImplementation()!
    sendRequest.mockImplementation((method, params) =>
      method === 'agentSession.queuedMessageMove'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : otherMethods(method, params)
    )
    let moving!: Promise<boolean>
    await act(async () => {
      moving = hook!.queued.move!({ movedId: 'mail', afterId: 'b' })
    })
    expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['b', 'mail'])
    expect(hook!.queued.cards[1]?.from).toBeDefined()
    expect(requestOf('agentSession.queuedMessageMove').params).toMatchObject({
      messageId: 'mail',
      afterMessageId: 'b'
    })
    await act(async () => {
      finish(mutationOk({ messageId: 'mail', status: 'stale' }))
      expect(await moving).toBe(false)
    })
    expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['mail', 'b'])
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
        return normalReply(method)
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
      expect(asyncStorage.setItem).not.toHaveBeenCalled()
    })

    it("sends straight into the turn when the host's setting is Steer, as the desktop does", async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'settings.get') {
          return ok({ settings: { nativeChatQueueFollowUps: false } })
        }
        if (method === 'agentSession.send') {
          return mutationOk({
            clientMessageId: 'client-1',
            submission: acceptedSubmission('client-1')
          })
        }
        return normalReply(method)
      })
      await mountSession(CAPABLE)
      await vi.waitFor(() =>
        expect(sendRequest.mock.calls.map(([method]) => method)).toContain('settings.get')
      )
      await act(async () => {})
      await act(async () => {
        await hook!.sendWithOutcome('steer me')
      })
      expect('delivery' in requestOf('agentSession.send').params).toBe(false)
    })

    it.each(['steer', 'queue'] as const)(
      'pre-turn host Working honors default and explicit choice (%s)',
      async (behavior) => {
        sendRequest.mockImplementation(async (method) => {
          if (method === 'settings.get') {
            return ok({ settings: { nativeChatQueueFollowUps: behavior === 'queue' } })
          }
          if (method === 'agentSession.send') {
            return mutationOk({
              clientMessageId: 'client-1',
              submission: acceptedSubmission('client-1')
            })
          }
          return normalReply(method)
        })
        await mountSession(CAPABLE, {
          ...snapshotEvent(),
          page: {
            ...snapshotEvent().page,
            working: true,
            latestTurn: null,
            nextQueuedMessageId: null
          }
        })
        await act(async () => {})
        expect(hook!.isWorking).toBe(true)
        expect(hook!.sendFollowUp).toEqual({ action: behavior, offersChoice: true })
        for (const alternate of [false, true]) {
          await act(async () => {
            await hook!.sendWithOutcome(
              'pre-turn',
              undefined,
              undefined,
              undefined,
              [],
              alternate ? { alternate: true } : undefined
            )
          })
          expect(requestOf('agentSession.send', alternate ? 1 : 0).params.delivery).toBe(
            (behavior === 'queue') !== alternate ? 'queue-if-active' : undefined
          )
        }
        // A sheet opened during work sends against the current idle state.
        await act(async () =>
          listener?.({
            ...snapshotEvent(),
            page: {
              ...snapshotEvent().page,
              working: false,
              latestTurn: null,
              nextQueuedMessageId: null
            }
          })
        )
        await act(async () => {
          await hook!.sendWithOutcome('now idle', undefined, undefined, undefined, [], {
            alternate: true
          })
        })
        expect(requestOf('agentSession.send', 2).params.delivery).toBe(
          behavior === 'queue' ? 'queue-if-active' : undefined
        )
      }
    )

    it('sends using a changed host preference in the same connected chat', async () => {
      sendRequest.mockImplementation(async (method) =>
        method === 'agentSession.send'
          ? mutationOk({ clientMessageId: 'client-1', submission: acceptedSubmission('client-1') })
          : normalReply(method)
      )
      await mountSession(CAPABLE, {
        ...snapshotEvent(),
        page: {
          ...snapshotEvent().page,
          working: true,
          latestTurn: null,
          nextQueuedMessageId: null
        }
      })
      expect(hook!.sendFollowUp).toEqual({ action: 'queue', offersChoice: true })
      await act(async () => {
        await hook!.sendWithOutcome('queue by default')
      })
      expect(requestOf('agentSession.send').params.delivery).toBe('queue-if-active')
      await act(async () =>
        preferenceListener?.({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false })
      )
      expect(hook!.sendFollowUp).toEqual({ action: 'steer', offersChoice: true })
      await act(async () => {
        await hook!.sendWithOutcome('now steer')
      })
      expect(requestOf('agentSession.send', 1).params.delivery).toBeUndefined()
      expect(
        subscribe.mock.calls.filter(([method]) => method === 'agentSession.subscribe')
      ).toHaveLength(1)
      expect(calls('settings.get')).toHaveLength(1)
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
        return normalReply(method)
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

    it('a new send follows the current host capability after acknowledgement loss', async () => {
      let attempts = 0
      sendRequest.mockImplementation(async (method, params) => {
        if (method !== 'agentSession.send') {
          return normalReply(method)
        }
        if (++attempts === 1) {
          throw markRpcDeliveryUnknown(new Error('Connection closed'))
        }
        const id = String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
        return mutationOk({ clientMessageId: id, submission: acceptedSubmission(id) })
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.sendWithOutcome('again')).toBe('unknown')
      })
      await unmountSession()
      await mountSession(LEGACY)
      await act(async () => {
        expect(await hook!.sendWithOutcome('again')).toBe('accepted')
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
        return normalReply(method)
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
      expect(await hook!.sendWithOutcome('held')).toBe('unknown')
    })
    const firstId = String(requestOf('agentSession.send').envelope.clientOperationId)
    act(() => listener?.(batchEvent([queuedDraft({ messageId: firstId })])))
    await act(async () => {
      expect(await hook!.sendWithOutcome('held')).toBe('queued')
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
          position: 1,
          text: 'text of draft-1',
          line: 'text of draft-1',
          state: 'waiting',
          hold: 'turn',
          needsAttention: false,
          caption: null,
          attribution: null
        }
      ])
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
          items: [
            {
              itemId: agentJournalSubmissionKey('fresh-hand-off-id'),
              revision: 1,
              sequence: 1,
              observedAt: 10,
              body: {
                kind: 'message',
                role: 'user',
                blocks: [{ type: 'text', text: 'sent message' }]
              }
            }
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
          items: [
            {
              itemId: agentJournalSubmissionKey('same-id'),
              revision: 1,
              sequence: 1,
              observedAt: 10,
              body: {
                kind: 'message',
                role: 'user',
                blocks: [{ type: 'text', text: 'sent message' }]
              }
            }
          ],
          submissions: [acceptedSubmission('same-id')]
        })
      )
      expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['same-id'])
    })

    // Any host may publish retained drafts after restart even if it cannot queue fresh sends.
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
        return normalReply(method)
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
          : normalReply(method)
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
        return normalReply(method)
      })
      await mountSession(CAPABLE)
      await act(async () => {
        expect(await hook!.queued.delete('draft-1')).toBe(false)
      })
      expect(onSendError).toHaveBeenCalledWith('This message was already sent.')
    })

    it('Clear all deletes every shown card on the existing host contract', async () => {
      const ids = ['draft-1', 'draft-2']
      sendRequest.mockImplementation(async (method, params) =>
        method === 'agentSession.queuedMessageDelete'
          ? fieldsOf(params).messageId === 'draft-1'
            ? mutationOk({ deleted: true, messageId: 'draft-1' })
            : mutationOk({ deleted: false, messageId: 'draft-2', disposition: 'missing' })
          : normalReply(method)
      )
      await mountSession(
        LEGACY,
        snapshotEvent({ queuedMessages: ids.map((messageId) => queuedDraft({ messageId })) })
      )
      expect(hook!.queued.clear).toBeDefined()
      await act(async () => expect(await hook!.queued.clear(ids)).toBe(true))
      expect(calls('agentSession.queuedMessageDelete')).toHaveLength(2)
      expect(requestOf('agentSession.queuedMessageDelete', 1).params.messageId).toBe('draft-2')
    })

    it('Edit copies the card’s shown text into the composer before its delete leaves', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageDelete') {
          return mutationOk({ deleted: true, messageId: 'draft-1' })
        }
        return normalReply(method)
      })
      await mountSession(
        LEGACY,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      await act(async () => {
        expect(await hook!.queued.edit!('draft-1')).toBe(true)
      })
      expect(appendText.mock.calls).toEqual([['text of draft-1']])
      // Copy before Delete leaves no outcome that can lose card text.
      expect(appendText.mock.invocationCallOrder[0]).toBeLessThan(
        callOrderOf('agentSession.queuedMessageDelete')!
      )
      expect(requestOf('agentSession.queuedMessageDelete').params.messageId).toBe('draft-1')
      expect(asyncStorage.setItem).not.toHaveBeenCalled()
    })

    it('Edit keeps the copied text when the delete fails; the card stays beside it', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageDelete') {
          return { id: 'request-1', ok: false, error: { code: 'runtime_error', message: 'boom' } }
        }
        return normalReply(method)
      })
      await mountSession(
        LEGACY,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      await act(async () => {
        expect(await hook!.queued.edit!('draft-1')).toBe(false)
      })
      // Failed delete leaves both visible copies without restoring text a second time.
      expect(appendText.mock.calls).toEqual([['text of draft-1']])
      expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['draft-1'])
    })

    it('Edit racing the drain still copies; the user hears it already went out', async () => {
      sendRequest.mockImplementation(async (method) => {
        if (method === 'agentSession.queuedMessageDelete') {
          return mutationOk({ deleted: false, messageId: 'draft-1', disposition: 'dispatched' })
        }
        return normalReply(method)
      })
      await mountSession(
        LEGACY,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      await act(async () => {
        expect(await hook!.queued.edit!('draft-1')).toBe(false)
      })
      expect(appendText.mock.calls).toEqual([['text of draft-1']])
      // Report that the copy remains in the composer so users do not resend it as though nothing happened.
      expect(onSendError).toHaveBeenCalledWith('Already sent — your text is still in the composer.')
    })

    it('Edit that copied nothing deletes nothing and does not report a copy', async () => {
      sendRequest.mockImplementation(async (method) => normalReply(method))
      await mountSession(
        LEGACY,
        snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] })
      )
      appendText.mockReturnValueOnce(false)
      const onCopied = vi.fn()
      await act(async () => {
        expect(await hook!.queued.edit!('draft-1', onCopied)).toBe(false)
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
        return normalReply(method)
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
      const { params } = requestOf('agentSession.cancel')
      expect(Object.keys(params).sort()).toEqual(['envelope', 'turnId'])
      expect(params.turnId).toBe('turn-1')
      expect(appendText).not.toHaveBeenCalled()
      expect(asyncStorage.setItem).not.toHaveBeenCalled()
      expect(hook!.queued.cards.map((card) => card.messageId)).toEqual(['draft-1'])
      act(() =>
        listener?.(batchEvent([queuedDraft({ messageId: 'draft-1' })], [], { reason: 'stopped' }))
      )
      expect(hook!.queued.pause).toEqual({ reason: 'stopped' })
      expect(hook!.queued.cards[0]).toMatchObject({
        messageId: 'draft-1',
        hold: 'queue-paused',
        caption: null
      })
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
        return normalReply(method)
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
        return normalReply(method)
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
