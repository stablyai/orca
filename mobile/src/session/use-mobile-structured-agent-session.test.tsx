import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { formatQuestionFreeTextAnswer } from './mobile-native-chat-question'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

function ok(result: unknown) {
  return { ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function snapshotEvent(fence = 3): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence,
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: null,
        newest: null,
        nextCursor: { epoch: 'epoch-1', sequence: 0 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    }
  }
}

function snapshotWithMessage(): AgentSessionSubscribeEvent {
  const event = snapshotEvent()
  return {
    ...event,
    page: {
      ...event.page,
      items: [
        {
          itemId: 'msg-1',
          revision: 1,
          sequence: 1,
          observedAt: 10,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'sent before the blip' }]
          }
        }
      ],
      window: {
        oldest: { epoch: 'epoch-1', sequence: 1 },
        newest: { epoch: 'epoch-1', sequence: 1 },
        nextCursor: { epoch: 'epoch-1', sequence: 2 }
      },
      liveCursor: { epoch: 'epoch-1', sequence: 1 }
    }
  } as AgentSessionSubscribeEvent
}

function pendingResolution(): AgentJournalResolution {
  return {
    state: 'pending',
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
}

function approvalItem(): AgentJournalRenderItem {
  return {
    itemId: 'approval-1',
    revision: 2,
    sequence: 1,
    observedAt: 10,
    body: {
      kind: 'approval',
      title: 'Allow Bash?',
      detail: 'rm -rf build',
      options: [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' }
      ],
      resolution: pendingResolution()
    }
  }
}

function approvalItemWithIdentity(itemId: string, revision: number): AgentJournalRenderItem {
  return { ...approvalItem(), itemId, revision }
}

function questionItem(): AgentJournalRenderItem {
  return {
    itemId: 'question-1',
    revision: 7,
    sequence: 2,
    observedAt: 12,
    body: {
      kind: 'question',
      question: 'Pick destination',
      freeTextQuestionId: 'free-q',
      options: [
        { id: 'choice-a', label: 'Choice A' },
        { id: 'choice-b', label: 'Choice B' }
      ],
      resolution: pendingResolution()
    }
  }
}

function questionItemWithIdentity(itemId: string, revision: number): AgentJournalRenderItem {
  return { ...questionItem(), itemId, revision }
}

function runningStatusItem(): AgentJournalRenderItem {
  return {
    itemId: 'status-1',
    revision: 1,
    sequence: 3,
    observedAt: 14,
    body: {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-1', state: 'running' }
    }
  }
}

function defaultSendRequest(method: string, params?: Record<string, unknown>) {
  if (method === 'agentSession.send') {
    return ok({
      ok: true,
      replayed: false,
      fence: 3,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: { turnId: 'turn-1' }
    })
  }
  if (method === 'agentSession.options') {
    return ok({
      models: [
        {
          id: 'gpt-fast',
          label: 'GPT Fast',
          isDefault: true,
          defaultEffort: 'low',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        },
        {
          id: 'gpt-slow',
          label: 'GPT Slow',
          isDefault: false,
          defaultEffort: 'high',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ],
      current: {
        model: 'gpt-fast',
        effort: 'low'
      }
    })
  }
  if (method === 'agentSession.setOption') {
    return ok({
      ok: true,
      replayed: false,
      fence: 3,
      cursor: { epoch: 'epoch-1', sequence: 2 },
      value: {
        key: 'model',
        value: 'gpt-fast',
        options: { model: 'gpt-fast' }
      }
    })
  }
  if (method === 'agentSession.respondToApproval' || method === 'agentSession.respondToQuestion') {
    return ok({
      ok: true,
      replayed: false,
      fence: 3,
      cursor: { epoch: 'epoch-1', sequence: 3 },
      value: {
        itemId: String(params?.itemId ?? ''),
        revision: 2,
        resolution: {
          state: 'resolved',
          selectedOptionId: String(params?.optionId ?? ''),
          resolvedBy: 'mobile',
          resolvedAt: 123
        }
      }
    })
  }
  return ok({})
}

describe('useMobileStructuredAgentSession', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  const onSendError = vi.fn()
  const unsubscribe = vi.fn()
  const sendRequest = vi.fn(defaultSendRequest)
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return unsubscribe
  })
  const client = {
    sendRequest,
    subscribe
  } as unknown as RpcClient

  function Harness({
    sessionId = 'session-1',
    agent = 'codex',
    connected = true,
    sourceIdentity = 'host-a\0workspace-a'
  }: {
    sessionId?: string | null
    agent?: string | null
    connected?: boolean
    sourceIdentity?: string
  }): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId,
      sourceIdentity,
      enabled: true,
      connected,
      agent,
      onSendError
    } as never)
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sendRequest.mockImplementation(defaultSendRequest)
    listener = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  it('subscribes and holds structured sessions without nativeChat or terminal RPCs', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })

    await vi.waitFor(() =>
      expect(subscribe).toHaveBeenCalledWith(
        'agentSession.subscribe',
        { sessionId: 'session-1' },
        expect.any(Function)
      )
    )
    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith(
        'agentSession.hold',
        expect.objectContaining({ sessionId: 'session-1', holderId: expect.any(String) }),
        expect.any(Object)
      )
    )
    expect(sendRequest).not.toHaveBeenCalledWith(
      expect.stringMatching(/^(nativeChat|terminal)\./),
      expect.anything(),
      expect.anything()
    )
  })

  it('re-holds after a reconnect that outlives the host release grace', async () => {
    act(() => {
      renderer = create(createElement(Harness, { connected: true }))
    })
    await vi.waitFor(() =>
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.hold')
      ).toHaveLength(1)
    )
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))

    // A transport loss retires the connection-scoped hold; after the host's 15s grace
    // it may evict the provider child. Reconnect must acquire before replaying the stream.
    await act(async () => {
      renderer?.update(createElement(Harness, { connected: false }))
    })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await act(async () => {
      renderer?.update(createElement(Harness, { connected: true }))
    })

    await vi.waitFor(() =>
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.hold')
      ).toHaveLength(2)
    )
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
    const holdOrders = sendRequest.mock.calls
      .map((call, index) =>
        call[0] === 'agentSession.hold' ? sendRequest.mock.invocationCallOrder[index] : null
      )
      .filter((order): order is number => order !== null)
    const subscribeOrders = subscribe.mock.invocationCallOrder
    const secondHoldOrder = holdOrders[1]
    const secondSubscribeOrder = subscribeOrders[1]
    if (secondHoldOrder === undefined || secondSubscribeOrder === undefined) {
      throw new Error('reconnect calls were not recorded')
    }
    expect(secondHoldOrder).toBeLessThan(secondSubscribeOrder)
  })

  it('sends with the shared structured mutation envelope after the stream fence lands', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent()))

    let outcome: 'accepted' | 'unknown' | 'rejected' = 'rejected'
    await act(async () => {
      outcome = await hook!.sendWithOutcome('hello')
    })

    expect(outcome).toBe('accepted')
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.send',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'session-1',
          expectedRuntimeFence: 3,
          clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
          payloadFingerprint: expect.any(String)
        }),
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }]
        }
      }),
      expect.any(Object)
    )
  })

  it('surfaces structured prompt cards and option snapshots', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent(3)))
    act(() => listener?.(snapshotEvent(3)))
    act(() =>
      listener?.({
        ...snapshotEvent(3),
        page: {
          ...snapshotEvent(3).page,
          items: [approvalItem(), questionItem()]
        }
      })
    )

    if (!hook) {
      throw new Error('hook not ready')
    }

    await vi.waitFor(() => expect(hook.permission).not.toBeNull())
    await vi.waitFor(() => expect(hook.question).not.toBeNull())
    await vi.waitFor(() => expect(hook.optionSnapshot.length).toBeGreaterThan(0))

    expect(hook.permission).toMatchObject({
      title: 'Allow Bash?',
      detail: 'rm -rf build',
      options: [
        { label: 'Allow once', send: expect.any(String) },
        { label: 'Deny', send: expect.any(String) }
      ]
    })
    expect(hook.question).toMatchObject({
      question: 'Pick destination',
      allowOther: true,
      optionTokens: [expect.any(String), expect.any(String)],
      freeTextToken: expect.any(String)
    })
    expect(hook.optionSurface.getSnapshot()).toEqual(hook.optionSnapshot)

    await act(async () => {
      expect(await hook.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.setOption',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'session-1',
          expectedRuntimeFence: 3,
          clientOperationId: expect.any(String),
          payloadFingerprint: expect.any(String)
        }),
        key: 'model',
        value: 'gpt-fast'
      }),
      expect.any(Object)
    )

    await act(async () => {
      expect(await hook.respondPermission(hook.permission!.options[0]!.send)).toBe(true)
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.respondToApproval',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'session-1',
          expectedRuntimeFence: 3
        }),
        itemId: 'approval-1',
        optionId: 'allow-once'
      }),
      expect.any(Object)
    )

    await act(async () => {
      expect(
        await hook.respondQuestion(formatQuestionFreeTextAnswer(hook.question!, 'custom answer'))
      ).toBe(true)
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.respondToQuestion',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'session-1',
          expectedRuntimeFence: 3
        }),
        itemId: 'question-1',
        optionId: `${encodeURIComponent('free-q')}:${encodeURIComponent('custom answer')}`
      }),
      expect.any(Object)
    )
  })

  it('sends structured image attachments in the message body', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent(3)))

    let outcome: 'accepted' | 'unknown' | 'rejected' = 'rejected'
    await act(async () => {
      outcome = await hook.sendWithOutcome('look at this', undefined, undefined, [
        { path: '/tmp/a.png', previewUri: 'file:///a.jpg' }
      ])
    })

    expect(outcome).toBe('accepted')
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.send',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'session-1',
          expectedRuntimeFence: 3,
          clientOperationId: expect.any(String),
          payloadFingerprint: expect.any(String)
        }),
        body: {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'text', text: 'look at this' },
            { type: 'image-ref', path: '/tmp/a.png' }
          ]
        }
      }),
      expect.any(Object)
    )
  })

  it('rejects preview-only structured image URIs instead of sending them as host paths', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent(3)))
    sendRequest.mockClear()

    let outcome: 'accepted' | 'unknown' | 'rejected' = 'accepted'
    await act(async () => {
      outcome = await hook!.sendWithOutcome('look at this', ['file:///a.jpg'])
    })

    expect(outcome).toBe('rejected')
    expect(onSendError).toHaveBeenCalledWith('Message not sent')
    expect(sendRequest).not.toHaveBeenCalledWith(
      'agentSession.send',
      expect.objectContaining({
        body: expect.objectContaining({
          blocks: expect.arrayContaining([{ type: 'image-ref', path: 'file:///a.jpg' }])
        })
      }),
      expect.any(Object)
    )
  })

  it('answers the prompt captured by a structured card after a newer prompt lands', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() =>
      listener?.({
        ...snapshotEvent(3),
        page: {
          ...snapshotEvent(3).page,
          items: [
            approvalItemWithIdentity('approval-old', 4),
            questionItemWithIdentity('question-old', 8)
          ]
        }
      })
    )
    const approvalToken = hook!.permission!.options[0]!.send
    const questionToken = hook!.question!.optionTokens[0]!
    const freeText = formatQuestionFreeTextAnswer(hook!.question!, 'old answer')

    act(() =>
      listener?.({
        ...snapshotEvent(3),
        page: {
          ...snapshotEvent(3).page,
          items: [
            approvalItemWithIdentity('approval-new', 9),
            questionItemWithIdentity('question-new', 10)
          ]
        }
      })
    )
    sendRequest.mockClear()

    await act(async () => {
      expect(await hook!.respondPermission(approvalToken)).toBe(true)
      expect(await hook!.respondQuestion(questionToken)).toBe(true)
      expect(await hook!.respondQuestion(freeText)).toBe(true)
    })

    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.respondToApproval',
      expect.objectContaining({
        itemId: 'approval-old',
        expectedRevision: 4,
        optionId: 'allow-once'
      }),
      expect.any(Object)
    )
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.respondToQuestion',
      expect.objectContaining({
        itemId: 'question-old',
        expectedRevision: 8,
        optionId: 'choice-a'
      }),
      expect.any(Object)
    )
    expect(sendRequest).toHaveBeenCalledWith(
      'agentSession.respondToQuestion',
      expect.objectContaining({
        itemId: 'question-old',
        expectedRevision: 8,
        optionId: `${encodeURIComponent('free-q')}:${encodeURIComponent('old answer')}`
      }),
      expect.any(Object)
    )
  })

  it('surfaces unknown structured prompt responses as unconfirmed', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() =>
      listener?.({
        ...snapshotEvent(3),
        page: {
          ...snapshotEvent(3).page,
          items: [approvalItem(), questionItem()]
        }
      })
    )
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.respondToApproval') {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return defaultSendRequest(method, params)
    })
    onSendError.mockClear()

    await act(async () => {
      expect(await hook!.respondPermission(hook!.permission!.options[0]!.send)).toBe(false)
    })
    expect(onSendError).toHaveBeenCalledWith('Response unconfirmed — check chat before retrying')

    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.respondToQuestion') {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return defaultSendRequest(method, params)
    })
    onSendError.mockClear()

    await act(async () => {
      expect(await hook!.respondQuestion(hook!.question!.optionTokens[0]!)).toBe(false)
    })
    expect(onSendError).toHaveBeenCalledWith('Answer unconfirmed — check chat before retrying')
  })

  it('uses a fresh operation id when a prompt response delivery is unknown', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() =>
      listener?.({
        ...snapshotEvent(3),
        page: { ...snapshotEvent(3).page, items: [approvalItem()] }
      })
    )
    let attempts = 0
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.respondToApproval' && attempts++ === 0) {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return defaultSendRequest(method, params)
    })

    const token = hook!.permission!.options[0]!.send
    await act(async () => {
      expect(await hook!.respondPermission(token)).toBe(false)
      expect(await hook!.respondPermission(token)).toBe(true)
    })

    const calls = sendRequest.mock.calls.filter(
      ([method]) => method === 'agentSession.respondToApproval'
    )
    expect(calls).toHaveLength(2)
    const firstId = (calls[0]![1] as { envelope: { clientOperationId: string } }).envelope
      .clientOperationId
    const retryId = (calls[1]![1] as { envelope: { clientOperationId: string } }).envelope
      .clientOperationId
    expect(firstId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    expect(retryId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    expect(retryId).not.toBe(firstId)
  })

  it('marks a retried send as retryUnknown after ambiguous delivery', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent(3)))
    let attempts = 0
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.send' && attempts++ === 0) {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return defaultSendRequest(method, params)
    })

    await act(async () => {
      expect(await hook!.sendWithOutcome('retry me')).toBe('unknown')
      expect(await hook!.sendWithOutcome('retry me')).toBe('accepted')
    })

    const calls = sendRequest.mock.calls.filter(([method]) => method === 'agentSession.send')
    expect(calls).toHaveLength(2)
    expect(calls[0]![1]).not.toHaveProperty('retryUnknown')
    expect(calls[1]![1]).toMatchObject({ retryUnknown: true })
    const firstId = (calls[0]![1] as { envelope: { clientOperationId: string } }).envelope
      .clientOperationId
    const retryId = (calls[1]![1] as { envelope: { clientOperationId: string } }).envelope
      .clientOperationId
    expect(retryId).toBe(firstId)
  })

  it('keeps structured option changes dispatched after unknown delivery', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent(3)))
    await vi.waitFor(() => expect(hook!.optionSnapshot.length).toBeGreaterThan(0))
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.setOption') {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return defaultSendRequest(method, params)
    })
    onSendError.mockClear()

    await act(async () => {
      expect(await hook!.setStructuredOption('model', 'gpt-slow')).toBe(true)
    })

    const model = hook!.optionSnapshot.find((descriptor) => descriptor.id === 'model')
    expect(model).toMatchObject({
      valueSource: 'dispatched',
      kind: expect.objectContaining({ currentValue: 'gpt-slow' })
    })
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('reports structured Stop as unconfirmed after unknown delivery', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() =>
      listener?.({
        ...snapshotEvent(3),
        page: {
          ...snapshotEvent(3).page,
          items: [runningStatusItem()]
        }
      })
    )
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.cancel') {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return defaultSendRequest(method, params)
    })
    onSendError.mockClear()

    await act(async () => {
      hook!.cancel()
      await Promise.resolve()
    })

    expect(onSendError).toHaveBeenCalledWith('Stop unconfirmed — check chat before retrying')
  })

  it('releases a landed hold when the structured tab unmounts', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith(
        'agentSession.hold',
        expect.objectContaining({ sessionId: 'session-1' }),
        expect.any(Object)
      )
    )
    const held = sendRequest.mock.calls.find((call) => call[0] === 'agentSession.hold')?.[1] as {
      holderId: string
    }

    act(() => renderer?.unmount())

    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith(
        'agentSession.release',
        { sessionId: 'session-1', holderId: held.holderId },
        expect.any(Object)
      )
    )
  })

  it('keeps the transcript visible while reconnecting', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { connected: true }))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotWithMessage()))
    expect(hook?.session.messages).toHaveLength(1)

    await act(async () => {
      renderer?.update(createElement(Harness, { connected: false }))
    })
    expect(hook?.session.messages).toHaveLength(1)
    expect(hook?.session.status).toBe('ready')

    await act(async () => {
      renderer?.update(createElement(Harness, { connected: true }))
    })
    expect(hook?.session.messages).toHaveLength(1)
  })

  it('restores the correct cached transcript when switching tabs offline', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { connected: true, sessionId: 'session-1' }))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotWithMessage()))
    expect(hook?.session.messages).toHaveLength(1)

    await act(async () => {
      renderer?.update(createElement(Harness, { connected: false, sessionId: 'session-2' }))
    })
    expect(hook?.session.messages).toEqual([])
    expect(hook?.session.status).toBe('idle')

    await act(async () => {
      renderer?.update(createElement(Harness, { connected: false, sessionId: 'session-1' }))
    })
    expect(hook?.session.messages).toHaveLength(1)
  })

  it('isolates matching provider session ids across host and workspace sources', async () => {
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          connected: true,
          sessionId: 'session-1',
          sourceIdentity: 'host-a\0workspace-a'
        })
      )
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotWithMessage()))
    expect(hook?.session.messages).toHaveLength(1)

    await act(async () => {
      renderer?.update(
        createElement(Harness, {
          connected: false,
          sessionId: 'session-1',
          sourceIdentity: 'host-b\0workspace-b'
        })
      )
    })
    expect(hook?.session.messages).toEqual([])
  })
})
