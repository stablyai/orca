import { createElement } from 'react'
import {
  snapshotEvent as publishedSnapshot,
  fieldsOf,
  mutationOk,
  ok
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../../../src/shared/agent-session-journal-types'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat/input/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { formatQuestionFreeTextAnswer } from './native-chat/input/mobile-native-chat-question'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

function listedModelIds(snapshot: readonly SessionOptionDescriptor[]): string[] {
  const model = snapshot.find((descriptor) => descriptor.id === 'model')
  return model?.kind.type === 'select' ? model.kind.choices.map((choice) => choice.value) : []
}

function snapshotEvent(fence = 3, items: AgentJournalRenderItem[] = []) {
  return publishedSnapshot({ fence, items })
}

function snapshotWithMessage() {
  return snapshotEvent(3, [
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
  ])
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

async function defaultSendRequest(method: string, params?: unknown) {
  if (method === 'agentSession.send') {
    return mutationOk(structuredSendResultFixture('accepted'))
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
        itemId: String(fieldsOf(params).itemId ?? ''),
        revision: 2,
        resolution: {
          state: 'resolved',
          selectedOptionId: String(fieldsOf(params).optionId ?? ''),
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
  const unsubscribePreference = vi.fn()
  const sendRequest = vi.fn(defaultSendRequest)
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    if (_method === 'agentSession.subscribe') {
      listener = onData
      return unsubscribe
    }
    return unsubscribePreference
  })
  const client: RpcClient = {
    sendRequest,
    subscribe,
    getState: () => 'connected',
    onStateChange: () => () => {},
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    updateTerminalSubscriptionViewport: () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  let storedOperations: Map<string, string>

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

    storedOperations = new Map()
    asyncStorage.getItem.mockImplementation(
      async (key: string) => storedOperations.get(key) ?? null
    )
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      storedOperations.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      storedOperations.delete(key)
    })
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

  it('keeps creation facts out of the current phone conversation', async () => {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    const items: AgentJournalRenderItem[] = [
      {
        itemId: 'before',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Coordinate' }] }
      },
      {
        itemId: 'start',
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'agent-start',
          dispatchId: 'dispatch',
          task: 'Worker assignment',
          worker: {
            party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
            name: 'Worker'
          }
        }
      },
      {
        itemId: 'after',
        revision: 1,
        sequence: 3,
        observedAt: 3,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }] }
      }
    ]
    await act(async () => listener?.(snapshotEvent(3, items)))
    expect(hook?.session.messages.map(({ blocks }) => blocks)).toEqual([
      [{ type: 'text', text: 'Coordinate' }],
      [{ type: 'text', text: 'Answer' }]
    ])
  })

  it('re-holds before resubscribing after a reconnect', async () => {
    act(() => {
      renderer = create(createElement(Harness, { connected: true }))
    })
    await vi.waitFor(() =>
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.hold')
      ).toHaveLength(1)
    )
    await vi.waitFor(() =>
      expect(
        subscribe.mock.calls.filter(([method]) => method === 'agentSession.subscribe')
      ).toHaveLength(1)
    )

    // Reconnect must acquire the connection-scoped hold before replaying the stream.
    await act(async () => {
      renderer?.update(createElement(Harness, { connected: false }))
    })
    expect([unsubscribe.mock.calls.length, unsubscribePreference.mock.calls.length]).toEqual([1, 1])
    await act(async () => {
      renderer?.update(createElement(Harness, { connected: true }))
    })

    await vi.waitFor(() =>
      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.hold')
      ).toHaveLength(2)
    )
    await vi.waitFor(() =>
      expect(
        subscribe.mock.calls.filter(([method]) => method === 'agentSession.subscribe')
      ).toHaveLength(2)
    )
    const holdOrders = sendRequest.mock.calls
      .map((call, index) =>
        call[0] === 'agentSession.hold' ? sendRequest.mock.invocationCallOrder[index] : null
      )
      .filter((order): order is number => order !== null)
    const subscribeOrders = subscribe.mock.calls.flatMap(([method], index) =>
      method === 'agentSession.subscribe' ? [subscribe.mock.invocationCallOrder[index]] : []
    )
    const secondHoldOrder = holdOrders[1]
    const secondSubscribeOrder = subscribeOrders[1]
    if (secondHoldOrder === undefined || secondSubscribeOrder === undefined) {
      throw new Error('reconnect calls were not recorded')
    }
    expect(secondHoldOrder).toBeLessThan(secondSubscribeOrder)
    await act(async () => renderer?.unmount())
    renderer = null
    expect([unsubscribe.mock.calls.length, unsubscribePreference.mock.calls.length]).toEqual([2, 2])
  })

  it('sends with the shared structured mutation envelope after the stream fence lands', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent()))

    let outcome: MobileNativeChatSendOutcome = 'rejected'
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
    act(() => listener?.(snapshotEvent(3, [approvalItem(), questionItem()])))

    if (!hook) {
      throw new Error('hook not ready')
    }

    await vi.waitFor(() => expect(hook!.permission).not.toBeNull())
    await vi.waitFor(() => expect(hook!.question).not.toBeNull())
    await vi.waitFor(() => {
      expect(listedModelIds(hook!.optionSnapshot)).toContain('gpt-slow')
      expect(hook!.optionSnapshot.find((descriptor) => descriptor.id === 'model')).toMatchObject({
        settable: true
      })
    })

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
      expect(await hook!.setStructuredOption('model', 'gpt-fast')).toBe(true)
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
    expect(sendRequest).toHaveBeenCalledWith('settings.mutateNativeChatSessionOptions', {
      type: 'apply-picks',
      agent: 'codex',
      picks: [{ modelId: 'gpt-fast', optionId: 'model', value: 'gpt-fast' }]
    })

    await act(async () => {
      expect(await hook!.respondPermission(hook!.permission!.options[0]!.send)).toBe(true)
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
        await hook!.respondQuestion(formatQuestionFreeTextAnswer(hook!.question!, 'custom answer'))
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

    let outcome: MobileNativeChatSendOutcome = 'rejected'
    await act(async () => {
      outcome = await hook!.sendWithOutcome('look at this', undefined, undefined, [
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

    let outcome: MobileNativeChatSendOutcome = 'accepted'
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
      listener?.(
        snapshotEvent(3, [
          approvalItemWithIdentity('approval-old', 4),
          questionItemWithIdentity('question-old', 8)
        ])
      )
    )
    const approvalToken = hook!.permission!.options[0]!.send
    const questionToken = hook!.question!.optionTokens[0]!
    const freeText = formatQuestionFreeTextAnswer(hook!.question!, 'old answer')

    act(() =>
      listener?.(
        snapshotEvent(3, [
          approvalItemWithIdentity('approval-new', 9),
          questionItemWithIdentity('question-new', 10)
        ])
      )
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
    act(() => listener?.(snapshotEvent(3, [approvalItem(), questionItem()])))
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
    act(() => listener?.(snapshotEvent(3, [approvalItem()])))
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

  it('keeps unknown intent until a current query, without accepted memory or resend', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent(3)))
    await vi.waitFor(() => {
      expect(listedModelIds(hook!.optionSnapshot)).toContain('gpt-slow')
      expect(hook!.optionSnapshot.find((descriptor) => descriptor.id === 'model')).toMatchObject({
        settable: true
      })
    })
    let reconcile!: (response: Awaited<ReturnType<typeof defaultSendRequest>>) => void
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.setOption') {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      if (method === 'agentSession.options') {
        return new Promise<Awaited<ReturnType<typeof defaultSendRequest>>>((resolve) => {
          reconcile = resolve
        })
      }
      return defaultSendRequest(method, params)
    })
    onSendError.mockClear()

    await act(async () => {
      expect(await hook!.setStructuredOption('model', 'gpt-slow')).toBe(true)
    })

    const model = hook!.optionSnapshot.find((descriptor) => descriptor.id === 'model')
    expect(model?.kind).toMatchObject({ currentValue: 'gpt-slow' })
    expect(
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.setOption')
    ).toHaveLength(1)
    expect(
      sendRequest.mock.calls.filter(
        ([method]) => method === 'settings.mutateNativeChatSessionOptions'
      )
    ).toHaveLength(0)
    await act(async () => reconcile(await defaultSendRequest('agentSession.options')))
    expect(hook!.optionSnapshot.find((row) => row.id === 'model')?.kind).toMatchObject({
      currentValue: 'gpt-fast'
    })
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('reports structured Stop as unconfirmed after unknown delivery', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent(3, [runningStatusItem()])))
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
