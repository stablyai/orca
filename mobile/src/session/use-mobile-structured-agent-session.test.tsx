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
} from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat/input/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
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
  let clientState: ConnectionState = 'connected'
  const stateListeners = new Set<(state: ConnectionState) => void>()
  function setClientState(next: ConnectionState): void {
    clientState = next
    for (const stateListener of stateListeners) {
      stateListener(next)
    }
  }
  const client: RpcClient = {
    sendRequest,
    subscribe,
    getState: () => clientState,
    onStateChange: (stateListener) => {
      stateListeners.add(stateListener)
      return () => stateListeners.delete(stateListener)
    },
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
      pairedHostClient: client,
      sessionId,
      sourceIdentity,
      enabled: true,
      connected,
      hostSupport: null,
      agent,
      onSendError
    })
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
    clientState = 'connected'
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
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
    // The client reports its own drop before the route's connection prop follows.
    await act(async () => {
      setClientState('disconnected')
      renderer?.update(createElement(Harness, { connected: false }))
    })
    expect([unsubscribe.mock.calls.length, unsubscribePreference.mock.calls.length]).toEqual([1, 1])
    await act(async () => {
      setClientState('connected')
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
    // The shared preference stream reopens with its client: one read at mount, one after reconnect.
    expect(sendRequest.mock.calls.filter(([method]) => method === 'settings.get')).toHaveLength(2)
    expect(
      subscribe.mock.calls.filter(([method]) => method === 'runtime.clientEvents.subscribe')
    ).toHaveLength(2)
    await act(async () => renderer?.unmount())
    renderer = null
    expect([unsubscribe.mock.calls.length, unsubscribePreference.mock.calls.length]).toEqual([2, 2])
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
    // The picker is usable before fence 3's own read answers; only a read issued after the pick settles it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
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
