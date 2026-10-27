import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageEditHoldResult
} from '../../../src/shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { queuedMessageWithEdit } from '../../../src/shared/queued-message-edit'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  CAPABLE,
  SESSION_ID,
  batchEvent,
  fieldsOf,
  mutationOk,
  ok,
  queuedDraft,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

function withText(body: AgentSessionQueuedMessage['body'], text: string) {
  const edited = queuedMessageWithEdit(body, { text })
  if (!edited.ok) {
    throw new Error(edited.reason)
  }
  return edited.body
}

function editHoldReply(params: unknown): RpcResponse {
  const result: AgentSessionQueuedMessageEditHoldResult =
    fieldsOf(params).action === 'release'
      ? { status: 'released' }
      : { status: 'held', fingerprint: 'fp', leaseDurationMs: 120_000, remainingMs: 120_000 }
  return ok(result)
}

function readOrHoldReply(method: string, params: unknown): RpcResponse {
  return method === 'agentSession.queuedMessageEditHold'
    ? editHoldReply(params)
    : ok({ models: [], current: {} })
}

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

describe('mobile in-place queued Edit', () => {
  let renderer: ReactTestRenderer | undefined
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | undefined
  let listener: ((data: unknown) => void) | undefined
  const append = vi.fn(() => true)
  const error = vi.fn()
  const resolved = vi.fn()
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client: RpcClient = {
    sendRequest,
    subscribe: (_method, _params, onData) => {
      listener = onData
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
    transport = client
  }: {
    sessionId?: string
    editSupport?: boolean | null
    enabled?: boolean
    connected?: boolean
    transport?: RpcClient | null
  }): null {
    hook = useMobileStructuredAgentSession({
      client: transport,
      sessionId,
      sourceIdentity: 'host-a',
      enabled,
      connected,
      agent: 'codex',
      hostSupport:
        editSupport === null
          ? null
          : {
              ...CAPABLE,
              queuedMessages: false,
              queuedMessageEdit: editSupport
            },
      appendComposerText: append,
      onSendError: error,
      onActionResolved: resolved
    })
    return null
  }
  async function mount(message: AgentSessionQueuedMessage, editSupport: boolean | null = true) {
    vi.clearAllMocks()
    sendRequest.mockImplementation(async (method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? mutationOk({ status: 'updated', messageId: message.messageId, fingerprint: 'new' })
        : readOrHoldReply(method, params)
    )
    await act(async () => {
      renderer = create(createElement(Harness, { editSupport }))
    })
    act(() => listener?.(snapshotEvent({ queuedMessages: [message], runningTurn: true })))
    if (editSupport !== null) {
      await act(async () => {
        expect(await hook!.queued.edit!(message.messageId)).toBe(true)
      })
    }
  }
  afterEach(async () => {
    await act(async () => renderer?.unmount())
    vi.useRealTimers()
  })

  it('waits for the capability probe before offering the legacy fallback', async () => {
    await mount(queuedDraft({ messageId: 'draft-1' }), null)
    expect(hook!.queued.edit).toBeUndefined()
    expect(
      sendRequest.mock.calls.some(
        ([method]) =>
          method === 'agentSession.queuedMessageDelete' ||
          method === 'agentSession.queuedMessageEditHold'
      )
    ).toBe(false)
    await act(async () => renderer?.update(createElement(Harness, { editSupport: false })))
    expect(hook!.queued.edit).toEqual(expect.any(Function))
  })

  it('holds and renews a card while typing, sends only its edited text, and cancels in place', async () => {
    const message = queuedDraft({
      messageId: 'image-card',
      position: 7,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'original' },
          { type: 'image-ref', path: '/images/snapshot.png' }
        ]
      }
    })
    vi.useFakeTimers()
    await mount(message)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    const holdCalls = () =>
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageEditHold')
    const acquire = fieldsOf(holdCalls()[0]?.[1])
    expect(acquire).toMatchObject({
      sessionId: SESSION_ID,
      messageId: 'image-card',
      action: 'acquire',
      expectedBodyFingerprint: agentSessionSendBodyFingerprint(SESSION_ID, message.body)
    })
    expect(fieldsOf(holdCalls()[1]?.[1])).toMatchObject({ action: 'renew', editId: acquire.editId })
    act(() => hook!.queued.editor!.change('edited'))
    await act(async () => {
      expect(await hook!.queued.editor!.save()).toBe(true)
    })
    const update = sendRequest.mock.calls.find(
      ([method]) => method === 'agentSession.queuedMessageUpdate'
    )
    expect(fieldsOf(update?.[1])).toMatchObject({
      messageId: 'image-card',
      text: 'edited',
      expectedBodyFingerprint: acquire.expectedBodyFingerprint
    })
    expect(fieldsOf(update?.[1])).not.toHaveProperty('body')
    const body = withText(message.body, 'edited')
    act(() => listener?.(batchEvent([{ ...message, body }])))
    expect(hook!.queued.cards).toMatchObject([{ messageId: 'image-card', text: 'edited' }])
    expect(hook!.queued.editor).toBeUndefined()
    expect(fieldsOf(holdCalls().at(-1)?.[1])).toMatchObject({
      action: 'release',
      editId: acquire.editId
    })
    await act(async () => {
      await hook!.queued.edit!('image-card')
    })
    act(() => hook!.queued.editor!.change('cancelled'))
    await act(async () => hook!.queued.editor!.cancel())
    expect(hook!.queued.cards[0]?.text).toBe('edited')
    expect(
      sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageDelete')
    ).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })

  it('hands a stale Save to the composer and reopens on the newer text; keeps an unconfirmed one', async () => {
    const message = queuedDraft({ messageId: 'draft-1' })
    await mount(message)
    const newer = withText(message.body, 'edited elsewhere')
    sendRequest.mockImplementation(async (method, params) => {
      if (method !== 'agentSession.queuedMessageUpdate') {
        return readOrHoldReply(method, params)
      }
      listener?.(batchEvent([{ ...message, body: newer }]))
      return mutationOk({ status: 'changed', messageId: 'draft-1' })
    })
    act(() => hook!.queued.editor!.change('my text'))
    await act(async () => {
      expect(await hook!.queued.editor!.save()).toBe(false)
    })
    expect(append).toHaveBeenCalledWith('my text')
    expect(error).toHaveBeenCalledWith(
      'This message changed while you were editing. Your edit is in the chat box.'
    )
    expect(hook!.queued.editor).toMatchObject({ messageId: 'draft-1', text: 'edited elsewhere' })
    act(() => hook!.queued.editor!.change('saved text'))
    const body = withText(message.body, 'saved text')
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.queuedMessageUpdate') {
        listener?.(batchEvent([{ ...message, body }]))
        throw markRpcDeliveryUnknown(new Error('reply lost'))
      }
      return readOrHoldReply(method, params)
    })
    await act(async () => {
      await hook!.queued.editor!.save()
    })
    expect(hook!.queued.editor?.text).toBe('saved text')
    expect(hook!.queued.cards[0]?.text).toBe('saved text')
    const retry = sendRequest.mock.calls.findLast(
      ([method]) => method === 'agentSession.queuedMessageUpdate'
    )
    expect(fieldsOf(retry?.[1]).expectedBodyFingerprint).toBe(
      agentSessionSendBodyFingerprint(SESSION_ID, newer)
    )
    expect(error).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('abandons unsaved typing and releases the hold when changing chats', async () => {
    await mount(queuedDraft({ messageId: 'draft-1' }))
    act(() => hook!.queued.editor!.change('unsaved'))
    await act(async () => renderer?.update(createElement(Harness, { sessionId: 'other-chat' })))
    expect(append).not.toHaveBeenCalled()
    expect(hook!.queued.editor).toBeUndefined()
    expect(
      sendRequest.mock.calls
        .filter(([method]) => method === 'agentSession.queuedMessageEditHold')
        .map(([, params]) => fieldsOf(params).action)
    ).toEqual(['acquire', 'release'])
  })

  it.each(['updated', 'changed'] as const)(
    'ignores a deferred %s reply after leaving the chat',
    async (status) => {
      const message = queuedDraft({ messageId: 'deferred-card' })
      await mount(message)
      let answer: ((response: RpcResponse) => void) | undefined
      sendRequest.mockImplementation((method, params) =>
        method === 'agentSession.queuedMessageUpdate'
          ? new Promise<RpcResponse>((resolve) => {
              answer = resolve
            })
          : Promise.resolve(readOrHoldReply(method, params))
      )
      act(() => hook!.queued.editor!.change('edited in place'))
      let save: Promise<boolean> | undefined
      act(() => {
        save = hook!.queued.editor!.save()
      })
      expect(hook!.queued.editor!.saving).toBe(true)
      await act(async () => renderer?.update(createElement(Harness, { sessionId: 'other-chat' })))
      expect(append).not.toHaveBeenCalled()
      await act(async () => {
        answer?.(mutationOk({ status, messageId: message.messageId, fingerprint: 'new' }))
        await save
      })
      expect(append).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(resolved).not.toHaveBeenCalled()
      expect(hook!.queued.editor).toBeUndefined()
    }
  )

  it('retires a removed card during Save and ignores its late refusal while editing another card', async () => {
    const message = queuedDraft({ messageId: 'lost-reply-card' })
    const nextMessage = queuedDraft({ messageId: 'next-card', position: 2 })
    await mount(message)
    act(() => listener?.(batchEvent([message, nextMessage])))
    expect(hook!.queued.cards.map((card) => card.messageId)).toEqual([
      message.messageId,
      nextMessage.messageId
    ])
    let answer: ((response: RpcResponse) => void) | undefined
    sendRequest.mockImplementation((method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? new Promise<RpcResponse>((resolve) => {
            answer = resolve
          })
        : Promise.resolve(readOrHoldReply(method, params))
    )
    act(() => hook!.queued.editor!.change('submitted edit'))
    let save: Promise<boolean> | undefined
    act(() => {
      save = hook!.queued.editor!.save()
    })
    expect(hook!.queued.editor?.saving).toBe(true)
    act(() => listener?.(batchEvent([nextMessage])))
    expect(hook!.queued.editor).toBeUndefined()
    await act(async () => {
      expect(await hook!.queued.edit!(nextMessage.messageId)).toBe(true)
    })
    act(() => hook!.queued.editor!.change('next edit'))
    await act(async () => {
      answer?.(
        ok({
          ok: false,
          refusal: { code: 'agent_session_operation_invalid', message: 'Could not edit.' }
        })
      )
      expect(await save).toBe(false)
    })
    expect(hook!.queued.editor).toMatchObject({
      messageId: nextMessage.messageId,
      text: 'next edit',
      saving: false
    })
    expect(append).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(resolved).not.toHaveBeenCalled()
  })

  it('keeps a refused Save in the editor and closes only when the published card is gone', async () => {
    const message = queuedDraft({ messageId: 'refused-card' })
    await mount(message)
    sendRequest.mockImplementation(async (method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? ok({
            ok: false,
            refusal: { code: 'agent_session_operation_invalid', message: 'Could not edit.' }
          })
        : readOrHoldReply(method, params)
    )
    act(() => hook!.queued.editor!.change('keep this text'))
    await act(async () => {
      expect(await hook!.queued.editor!.save()).toBe(false)
    })
    expect(hook!.queued.editor?.text).toBe('keep this text')
    expect(hook!.queued.editor?.saving).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
    act(() => listener?.(batchEvent([])))
    expect(hook!.queued.editor).toBeUndefined()
  })

  it('keeps exact typing through disconnect and reacquires the hold on the replacement transport', async () => {
    vi.useFakeTimers()
    await mount(queuedDraft({ messageId: 'reconnect-card' }))
    const text = 'unsaved text\nwith spacing  and 🐈'
    act(() => hook!.queued.editor!.change(text))
    await act(async () =>
      renderer?.update(createElement(Harness, { connected: false, transport: null }))
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(hook!.queued.editor?.text).toBe(text)
    const reconnectedRequest = vi.fn<RpcClient['sendRequest']>(async (method, params) =>
      method === 'agentSession.queuedMessageEditHold'
        ? fieldsOf(params).action === 'renew'
          ? ok({ status: 'expired' })
          : editHoldReply(params)
        : ok({ models: [], current: {} })
    )
    await act(async () =>
      renderer?.update(
        createElement(Harness, { transport: { ...client, sendRequest: reconnectedRequest } })
      )
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(hook!.queued.editor?.text).toBe(text)
    expect(
      reconnectedRequest.mock.calls
        .filter(([method]) => method === 'agentSession.queuedMessageEditHold')
        .map(([, params]) => fieldsOf(params).action)
    ).toEqual(['renew', 'acquire'])
    expect(error).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    await act(async () => hook!.queued.editor!.cancel())
    await act(async () =>
      renderer?.update(createElement(Harness, { connected: false, transport: null }))
    )
    const calls = reconnectedRequest.mock.calls.length
    await act(async () => {
      expect(await hook!.queued.edit!('reconnect-card')).toBe(false)
    })
    expect(error).toHaveBeenCalledExactlyOnceWith('Reconnect to edit.')
    expect(hook!.queued.editor).toBeUndefined()
    expect(reconnectedRequest).toHaveBeenCalledTimes(calls)
  })

  it('submits Save while hold acquisition is still pending', async () => {
    const message = queuedDraft({ messageId: 'save-before-hold' })
    await mount(message)
    act(() => hook!.queued.editor!.cancel())
    let answerHold: ((response: RpcResponse) => void) | undefined
    sendRequest.mockImplementation((method, params) =>
      method === 'agentSession.queuedMessageEditHold' && fieldsOf(params).action === 'acquire'
        ? new Promise<RpcResponse>((resolve) => {
            answerHold = resolve
          })
        : method === 'agentSession.queuedMessageEditHold'
          ? Promise.resolve(readOrHoldReply(method, params))
          : Promise.resolve(
              mutationOk({ status: 'updated', messageId: message.messageId, fingerprint: 'new' })
            )
    )
    await act(async () => {
      await hook!.queued.edit!(message.messageId)
    })
    act(() => hook!.queued.editor!.change('saved without hold reply'))
    await act(async () => {
      expect(await hook!.queued.editor!.save()).toBe(true)
    })
    expect(hook!.queued.editor).toBeUndefined()
    expect(answerHold).toBeDefined()
    await act(async () => answerHold?.(editHoldReply({ action: 'acquire' })))
    expect(append).not.toHaveBeenCalled()
  })
})
