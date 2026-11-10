import { createElement } from 'react'
import {
  snapshotEvent as publishedSnapshot,
  fieldsOf,
  mutationOk,
  ok
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../../../test-support/query-client-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'

import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../transport/connection/connection-state'

import { structuredSendResultFixture } from '../../structured-agent-send-result.test-fixture'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

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

  it('isolates matching provider session ids across host and workspace sources', async () => {
    await act(async () => {
      renderer = createWithQueryClient(
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
