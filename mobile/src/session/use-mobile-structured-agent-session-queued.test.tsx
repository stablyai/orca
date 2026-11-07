import { createElement } from 'react'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../test-support/query-client-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileNativeChatSessionLane } from './native-chat/use-mobile-native-chat-session-lane'
import { useHostClient } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { WorkspaceServerContext } from '../transport/workspace-server-context'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'

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
// Test capability-gated queue writes with authoritative cards; Stop preserves host-held drafts and legacy Edit copies before deleting.

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

const pairedContext = vi.hoisted(
  (): {
    value: Pick<
      RpcClientContextValue,
      | 'acquire'
      | 'release'
      | 'getKnownState'
      | 'getClientId'
      | 'getAllClients'
      | 'subscribeHostState'
    > | null
  } => ({ value: null })
)
// The native context module loads react-native, so only its hook is replaced.
vi.mock('../transport/client-context', () => ({
  useRpcClientContext: () => {
    if (!pairedContext.value) {
      throw new Error('No paired-host fixture')
    }
    return pairedContext.value
  }
}))

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
      pairedHostClient: client,
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
      renderer = createWithQueryClient(
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

  it('exposes the existing operation id before RPC and retains its real accepted echo until read coverage', async () => {
    await mountSession(LEGACY)
    let reply = (_response: RpcResponse) => {}
    sendRequest.mockImplementation((method) =>
      method === 'agentSession.send'
        ? new Promise((resolve) => {
            reply = resolve
          })
        : Promise.resolve(normalReply(method))
    )
    const created = vi.fn()
    let sending!: ReturnType<NonNullable<typeof hook>['sendWithOutcome']>
    await act(async () => {
      sending = hook!.sendWithOutcome('answer', undefined, undefined, undefined, undefined, {
        onCreated: created
      })
    })
    expect(created).toHaveBeenCalledOnce()
    const id = String(requestOf('agentSession.send').envelope.clientOperationId)
    expect(created).toHaveBeenCalledWith(id)
    expect(created.mock.invocationCallOrder[0]).toBeLessThan(callOrderOf('agentSession.send')!)
    await act(async () => {
      reply(mutationOk({ clientMessageId: id, submission: acceptedSubmission(id) }))
      expect(await sending).toBe('accepted')
    })
    expect(
      hook!.session.messages.find((row) => row.id === agentJournalSubmissionKey(id))
    ).toMatchObject({ deliveryState: 'pending' })
    act(() => listener?.(batchEvent()))
    await vi.waitFor(() =>
      expect(
        hook!.session.messages.find((row) => row.id === agentJournalSubmissionKey(id))
      ).toBeUndefined()
    )
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
    it('routes preference reads to the paired desktop and sends to the workspace server', async () => {
      let serverValue: boolean | undefined = true
      const desktopValues = new Map<string, boolean | undefined>([
        ['a', false],
        ['b', true]
      ])
      const desktopEvents = new Map<string, (event: unknown) => void>()
      let refuseDesktopRead = false
      let holdDesktopRead: Promise<void> | null = null
      const desktops = new Map<string, RpcClient>()
      for (const id of ['a', 'b']) {
        desktops.set(id, {
          ...client,
          sendRequest: vi.fn<RpcClient['sendRequest']>(async (method, params, options) => {
            if (options?.envelope?.executionHost) {
              return client.sendRequest(method, params, options)
            }
            if (method === 'settings.get') {
              if (holdDesktopRead) {
                await holdDesktopRead
              }
              return refuseDesktopRead
                ? {
                    id: 'old',
                    ok: false,
                    error: { code: 'method_not_found', message: 'Unavailable' }
                  }
                : ok({ settings: { nativeChatQueueFollowUps: desktopValues.get(id) } })
            }
            return normalReply(method)
          }),
          subscribe: vi.fn<RpcClient['subscribe']>((method, params, callback, options) => {
            if (options?.envelope?.executionHost) {
              return client.subscribe(method, params, callback, options)
            }
            if (method === 'runtime.clientEvents.subscribe') {
              desktopEvents.set(id, callback)
            }
            return () => {
              desktopEvents.delete(id)
            }
          })
        })
      }
      pairedContext.value = {
        acquire: (id) => desktops.get(id) ?? null,
        release: () => {},
        getKnownState: () => 'connected',
        getClientId: () => 'phone',
        getAllClients: () => [...desktops].map(([hostId, client]) => ({ hostId, client })),
        subscribeHostState: () => () => {}
      }
      sendRequest.mockImplementation(async (method) => {
        if (method === 'settings.get') {
          return ok({ settings: { nativeChatQueueFollowUps: serverValue } })
        }
        if (method === 'agentSession.send') {
          return mutationOk({
            clientMessageId: 'client-1',
            submission: acceptedSubmission('client-1')
          })
        }
        return normalReply(method)
      })
      function Chat({ hostId }: { hostId: string }) {
        const workspace = useWorkspaceClient(hostId)
        hook = useMobileNativeChatSessionLane({
          client: workspace.client,
          pairedHostClient: workspace.pairedHostClient,
          hostId,
          connState: workspace.state,
          structured: true,
          resolution: {
            agent: 'claude',
            sessionId: SESSION_ID,
            transcriptPath: null,
            agentConfirmed: true,
            sessionLive: true
          },
          sourceIdentity: hostId,
          hostSupport: CAPABLE,
          appendComposerTextRef: { current: appendText },
          enabled: true,
          onSendError
        }).structuredSession
        return null
      }
      function Route({
        hostId,
        serverState = 'connected'
      }: {
        hostId: string
        serverState?: ConnectionState
      }) {
        const desktop = useHostClient(hostId)
        return createElement(
          WorkspaceServerContext.Provider,
          {
            value: {
              client: desktop.client
                ? scopeRpcClientToExecutionHost(desktop.client, 'runtime:server')
                : null,
              state: desktop.client ? serverState : 'connecting',
              desktopCapabilities: []
            }
          },
          createElement(Chat, { hostId })
        )
      }
      const working = {
        ...snapshotEvent(),
        page: {
          ...snapshotEvent().page,
          working: true,
          latestTurn: null,
          nextQueuedMessageId: null
        }
      }
      await act(async () => {
        renderer = createWithQueryClient(createElement(Route, { hostId: 'a' }))
      })
      await act(async () => listener?.(working))
      expect(hook!.sendFollowUp).toEqual({ action: 'steer', offersChoice: true })
      await act(async () => {
        await hook!.sendWithOutcome('follow desktop OFF')
      })
      expect(requestOf('agentSession.send').params.delivery).toBeUndefined()
      expect(
        sendRequest.mock.calls.find(([method]) => method === 'agentSession.send')?.[2]?.envelope
          ?.executionHost
      ).toBe('runtime:server')
      const desktop = desktops.get('a')!
      expect(
        vi
          .mocked(desktop.sendRequest)
          .mock.calls.some(
            ([method, , options]) =>
              method === 'settings.get' && options?.envelope?.executionHost === undefined
          )
      ).toBe(true)
      expect(
        vi
          .mocked(desktop.subscribe)
          .mock.calls.some(
            ([method, , , options]) =>
              method === 'runtime.clientEvents.subscribe' &&
              options?.envelope?.executionHost === undefined
          )
      ).toBe(true)

      await act(async () =>
        desktopEvents.get('a')?.({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: true })
      )
      await act(async () => {
        await hook!.sendWithOutcome('follow desktop ON')
      })
      expect(requestOf('agentSession.send', 1).params.delivery).toBe('queue-if-active')
      await act(async () =>
        preferenceListener?.({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false })
      )
      expect(hook!.sendFollowUp?.action).toBe('queue')

      // A refusal retains the desktop answer; an accepted missing field restores the old host path.
      refuseDesktopRead = true
      await act(async () => desktopEvents.get('a')?.({ type: 'ready', snapshot: {} }))
      expect(hook!.sendFollowUp?.action).toBe('queue')
      refuseDesktopRead = false
      desktopValues.set('a', undefined)
      await act(async () => desktopEvents.get('a')?.({ type: 'ready', snapshot: {} }))
      expect(hook!.sendFollowUp?.action).toBe('steer')
      serverValue = undefined
      await act(async () => preferenceListener?.({ type: 'ready', snapshot: {} }))
      expect(hook!.sendFollowUp?.action).toBe('queue')

      desktopValues.set('a', false)
      await act(async () =>
        desktopEvents.get('a')?.({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: false })
      )
      expect(hook!.sendFollowUp?.action).toBe('steer')

      // A server relay outage leaves the desktop stream open, so its toggle is current at recovery.
      await act(async () =>
        renderer!.update(createElement(Route, { hostId: 'a', serverState: 'disconnected' }))
      )
      expect(desktopEvents.has('a')).toBe(true)
      desktopValues.set('a', true)
      await act(async () =>
        desktopEvents.get('a')?.({ type: 'nativeChatQueueFollowUpsChanged', queueFollowUps: true })
      )
      // Held desktop reads mean recovery can't repair a toggle the phone missed.
      let releaseDesktopRead = () => {}
      holdDesktopRead = new Promise<void>((resolve) => {
        releaseDesktopRead = () => resolve()
      })
      const outageListener = listener
      await act(async () => renderer!.update(createElement(Route, { hostId: 'a' })))
      await vi.waitFor(() => expect(listener).not.toBe(outageListener))
      await act(async () => listener?.(working))
      await act(async () => {
        await hook!.sendWithOutcome('follow desktop toggled during the outage')
      })
      expect(requestOf('agentSession.send', 2).params.delivery).toBe('queue-if-active')
      holdDesktopRead = null
      await act(async () => releaseDesktopRead())
      expect(hook!.sendFollowUp?.action).toBe('queue')

      await act(async () => renderer!.update(createElement(Route, { hostId: 'b' })))
      await act(async () => listener?.(working))
      expect(hook!.sendFollowUp?.action).toBe('queue')
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
  })

  describe('card actions', () => {
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
  })
})
