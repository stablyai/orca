import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalDispatchState } from '../../../src/shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { fieldsOf, ok } from './use-mobile-structured-agent-session-queued.test-fixture'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import {
  useMobileNativeChatSendError,
  mobileNativeChatSendErrorMessage,
  type MobileNativeChatSendErrorDetails
} from './use-mobile-native-chat-send-error'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

function sendResult(dispatchState: AgentJournalDispatchState, reason: string | null = null) {
  return ok({
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: structuredSendResultFixture(dispatchState, reason)
  })
}

function snapshotEvent(): Extract<AgentSessionSubscribeEvent, { type: 'snapshot' }> {
  return {
    type: 'snapshot',
    sessionId: 'session-1',
    fence: 3,
    page: {
      sessionId: 'session-1',
      epoch: 'epoch-1',
      fence: 3,
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

describe('mobile structured send actions', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let banner: ReturnType<typeof useMobileNativeChatSendError> | null = null
  let listener: ((value: unknown) => void) | null = null
  let storedOperations: Map<string, string>
  const onSendError = vi.fn()
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

  function Harness() {
    banner = useMobileNativeChatSendError({ scopeKey: 'session-1', showToast: vi.fn() })
    banner.bannerMountedRef.current = true
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      hostSupport: null,
      onSendError
    })
    return createElement(
      'span',
      null,
      mobileNativeChatSendErrorMessage(banner, hook.session.messages)
    )
  }

  async function mountSession(): Promise<void> {
    act(() => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent()))
  }

  function calls() {
    return sendRequest.mock.calls.filter(([method]) => method === 'agentSession.send')
  }

  function sentIds(): string[] {
    return calls().map(([, params]) =>
      String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    onSendError.mockImplementation((message: string, details?: MobileNativeChatSendErrorDetails) =>
      banner?.show(message, details)
    )

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
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    banner = null
    listener = null
  })

  // The host's row is where a recorded, rejected message lives on the phone, as on the desktop.
  it('shows a message the host recorded and then rejected as not sent, in place', async () => {
    await mountSession()
    const event = snapshotEvent()
    if (event.type !== 'snapshot') {
      throw new Error('expected a snapshot')
    }
    const itemId = agentJournalSubmissionKey('rejected-1')
    act(() =>
      listener?.({
        ...event,
        page: {
          ...event.page,
          items: [
            {
              itemId,
              revision: 1,
              sequence: 1,
              observedAt: 10,
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'lost' }] }
            }
          ],
          submissions: [
            {
              clientMessageId: 'rejected-1',
              fence: 3,
              payloadFingerprint: 'fingerprint',
              dispatchState: 'rejected',
              providerItemId: null,
              reason: 'provider_write_failed: broken pipe',
              submittedAt: 10,
              resolvedAt: 10
            }
          ]
        }
      })
    )
    expect(hook!.session.messages).toEqual([expect.objectContaining({ id: itemId, unsent: true })])
  })

  // The transcript owns a message the host recorded, so the composer never gets it back.
  it('answers a recorded, rejected send as not sent in the chat: no banner and no hand-back', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send'
        ? sendResult('rejected', 'provider_write_failed: broken pipe')
        : method === 'agentSession.options'
          ? ok({ models: [], current: {} })
          : ok({})
    )
    await mountSession()

    await act(async () => {
      expect((await hook!.sendWithOutcome('recorded, then rejected')).outcome).toBe(
        'recorded-unsent'
      )
    })
    expect(onSendError).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'pending', 'accepted'] as const)(
    'a later Send owns a new id even when the earlier host answer was %s',
    async (state) => {
      sendRequest.mockImplementation(async (method) =>
        method === 'agentSession.send' ? sendResult(state) : ok({ models: [], current: {} })
      )
      await mountSession()
      await act(async () => {
        const outcome = state === 'unknown' ? 'unknown' : 'accepted'
        expect((await hook!.sendWithOutcome('same text')).outcome).toBe(outcome)
        expect((await hook!.sendWithOutcome('same text')).outcome).toBe(outcome)
      })
      expect(new Set(sentIds()).size).toBe(2)
    }
  )

  it('keeps the original unknown host row while allowing another Send', async () => {
    const original = structuredSendResultFixture('unknown')
    if (!('submission' in original)) {
      throw new Error('expected a submission answer')
    }
    const event = snapshotEvent()
    event.page.submissions = [original.submission]
    event.page.items = [
      {
        itemId: 'original-message',
        revision: 1,
        sequence: 1,
        observedAt: 10,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'same text' }] }
      }
    ]
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send' ? sendResult('accepted') : ok({ models: [], current: {} })
    )
    await mountSession()
    act(() => listener?.(event))
    const messages = hook!.session.messages
    expect(messages).toHaveLength(1)
    await act(async () => {
      expect((await hook!.sendWithOutcome('same text')).outcome).toBe('accepted')
    })
    expect(hook!.session.messages).toEqual(messages)
    expect(event.page.submissions[0]?.dispatchState).toBe('unknown')
    expect(calls()).toHaveLength(1)
  })

  it.each(['reply-before-row', 'row-before-commit'] as const)(
    'states delivery once and leaves auth guidance in the transcript for %s',
    async (order) => {
      const fact = {
        kind: 'notSignedIn',
        detail: { text: 'The provider key expired.', audience: 'person' }
      } as const
      const words = agentSessionFailureWords(fact, { agentName: 'Codex', surface: 'row' })
      const event = snapshotEvent()
      event.page.items = [
        {
          itemId: 'auth-row',
          sequence: 1,
          revision: 1,
          observedAt: 1,
          body: { kind: 'status', tone: 'error', ...words }
        }
      ]
      const value = structuredSendResultFixture('rejected', words.text)
      if (!('submission' in value)) {
        throw new Error('expected submission')
      }
      value.submission.rejection = fact
      sendRequest.mockImplementation(async (method) => {
        if (method !== 'agentSession.send') {
          return ok({ models: [], current: {} })
        }
        if (order === 'row-before-commit') {
          listener?.(event)
        }
        return ok({
          ok: true,
          replayed: false,
          fence: 3,
          cursor: { epoch: 'epoch-1', sequence: 1 },
          value
        })
      })
      await mountSession()
      await act(async () => {
        expect((await hook!.sendWithOutcome('my message')).outcome).toBe('recorded-unsent')
      })
      expect(onSendError).not.toHaveBeenCalled()
      if (order === 'reply-before-row') {
        expect(renderer!.root.findByType('span').children).toEqual([])
        act(() => listener?.(event))
      }
      expect(renderer!.root.findByType('span').children).toEqual([])
      expect(JSON.stringify(hook!.session.messages)).toContain(words.text)
      expect(onSendError).not.toHaveBeenCalled()
    }
  )

  it('does not replay an old action after remount', async () => {
    sendRequest.mockImplementation(async (method) => {
      if (method === 'agentSession.send') {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return ok({ models: [], current: {} })
    })
    await mountSession()
    await act(async () => {
      expect((await hook!.sendWithOutcome('survive remount')).outcome).toBe('unknown')
    })
    act(() => renderer?.unmount())
    renderer = null
    listener = null
    await mountSession()
    await act(async () => {
      expect((await hook!.sendWithOutcome('survive remount')).outcome).toBe('unknown')
    })
    expect(new Set(sentIds()).size).toBe(2)
  })

  it('uses newly uploaded attachment paths for a new action with the same image', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send' ? sendResult('unknown') : ok({ models: [], current: {} })
    )
    await mountSession()
    await act(async () => {
      for (const path of ['/tmp/original.png', '/tmp/reuploaded.png']) {
        expect(
          (
            await hook!.sendWithOutcome('describe', undefined, undefined, [
              {
                path,
                previewUri: 'file:///photo.jpg'
              }
            ])
          ).outcome
        ).toBe('unknown')
      }
    })
    expect(new Set(sentIds()).size).toBe(2)
    expect(calls()[1]?.[1]).toMatchObject({
      body: {
        blocks: expect.arrayContaining([{ type: 'image-ref', path: '/tmp/reuploaded.png' }])
      }
    })
  })

  it('reports a send stopped before the agent started it without sending it twice', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send'
        ? sendResult('rejected', DISPATCH_REJECTED_CANCELLED)
        : ok({ models: [], current: {} })
    )
    await mountSession()
    await act(async () => {
      expect((await hook!.sendWithOutcome('stopped')).outcome).toBe('accepted')
      expect((await hook!.sendWithOutcome('stopped')).outcome).toBe('accepted')
    })
    expect(calls()).toHaveLength(2)
    expect(new Set(sentIds()).size).toBe(2)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it.each(['invalid_argument', 'unauthorized'])(
    'a later Send is independent after a %s refusal',
    async (code) => {
      let attempts = 0
      sendRequest.mockImplementation(async (method) => {
        if (method !== 'agentSession.send') {
          return ok({ models: [], current: {} })
        }
        return ++attempts === 1
          ? {
              id: 'request-1',
              ok: false as const,
              error: { code, message: 'Message is not authorized' }
            }
          : sendResult('accepted')
      })
      await mountSession()
      await act(async () => {
        expect((await hook!.sendWithOutcome('again')).outcome).toBe('rejected')
        expect((await hook!.sendWithOutcome('again')).outcome).toBe('accepted')
      })
      expect(new Set(sentIds()).size).toBe(2)
    }
  )

  it('a new Send goes through after a stale-fence refusal', async () => {
    let attempts = 0
    sendRequest.mockImplementation(async (method) => {
      if (method !== 'agentSession.send') {
        return ok({ models: [], current: {} })
      }
      return ++attempts === 1
        ? ok({
            ok: false,
            refusal: {
              code: 'agent_session_checkpoint_stale',
              message: 'Fence moved',
              currentFence: 3
            }
          })
        : sendResult('accepted')
    })
    await mountSession()
    await act(async () => {
      expect((await hook!.sendWithOutcome('again')).outcome).toBe('rejected')
      expect((await hook!.sendWithOutcome('again')).outcome).toBe('accepted')
    })
    expect(new Set(sentIds()).size).toBe(2)
  })

  it('never reads an old phone journal, even when storage is full or unreadable', async () => {
    asyncStorage.getItem.mockRejectedValue(new Error('unreadable old journal'))
    asyncStorage.setItem.mockRejectedValue(new Error('disk full'))
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.send' ? sendResult('accepted') : ok({ models: [], current: {} })
    )
    await mountSession()
    await act(async () => {
      expect((await hook!.sendWithOutcome('new action')).outcome).toBe('accepted')
    })
    expect(asyncStorage.getItem).not.toHaveBeenCalled()
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('sends nothing once the action budget expires', async () => {
    await mountSession()
    await act(async () => {
      expect((await hook!.sendWithOutcome('never attempted', undefined, 0)).outcome).toBe(
        'rejected'
      )
    })
    expect(calls()).toHaveLength(0)
  })
})
