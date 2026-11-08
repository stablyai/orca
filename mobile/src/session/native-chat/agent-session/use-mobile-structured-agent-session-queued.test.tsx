import { createElement } from 'react'
import { agentJournalSubmissionKey } from '../../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../../../test-support/query-client-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../src/shared/agent-session/agent-session-wire'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import { markRpcDeliveryUnknown } from '../../../transport/rpc/rpc-delivery-ambiguity'
import type { StructuredAgentSessionHostSupport } from '../../mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentSession } from '../../use-mobile-structured-agent-session'

import type { RpcClientContextValue } from '../../../transport/connection/rpc-client-context-contract'

import {
  CAPABLE,
  LEGACY,
  SESSION_ID,
  acceptedSubmission,
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
vi.mock('../../../transport/connection/client-context', () => ({
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
  let stored: Map<string, string>
  const onSendError = vi.fn()
  const appendText = vi.fn((_text: string) => true)
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, onData) => {
    if (_method === 'agentSession.subscribe') {
      listener = onData
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

  describe('capability-gated delivery', () => {
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
})
