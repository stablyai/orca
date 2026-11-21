import { createElement } from 'react'
import { act } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { createWithQueryClient } from '../../../test-support/query-client-test-renderer'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  mutationOk,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

// The live read waits for the app to be active before drawing streamed text.
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

function question(itemId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId,
    sequence,
    observedAt: sequence,
    revision: 3,
    body: {
      kind: 'question',
      question: 'Choose a value',
      options: [{ id: 'yes', label: 'Yes' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
}

it('selects and answers the linked second question with its own revision', async () => {
  let listener: ((data: unknown) => void) | undefined
  const sendRequest = vi.fn(async (method: string, _params: unknown) =>
    method === 'agentSession.respondToQuestion' ? mutationOk({}) : ok({})
  )
  const partial: Pick<RpcClient, 'sendRequest' | 'subscribe' | 'getState' | 'onStateChange'> = {
    sendRequest,
    getState: () => 'connected',
    onStateChange: () => () => {},
    subscribe: (method, _params, onData) => {
      if (method === 'agentSession.subscribe') {
        listener = onData
      }
      return () => {}
    }
  }
  let shown: ReturnType<typeof useMobileStructuredAgentSession> | undefined
  const target = { sessionId: 'session-1', itemId: 'question-2' }
  function Harness() {
    shown = useMobileStructuredAgentSession({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this session uses only the supplied request, subscription and connection members.
      client: partial as RpcClient,
      pairedHostClient: null,
      sessionId: 'session-1',
      sourceIdentity: 'linked-question-test',
      enabled: true,
      connected: true,
      agent: 'codex',
      hostSupport: null,
      onSendError: vi.fn(),
      itemLink: { selection: target, navigation: { target, complete: () => {} }, access: null }
    })
    return null
  }
  let tree: ReturnType<typeof createWithQueryClient> | undefined
  try {
    act(() => {
      tree = createWithQueryClient(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() =>
      listener?.(snapshotEvent({ items: [question('question-1', 1), question('question-2', 2)] }))
    )
    await vi.waitFor(() =>
      expect(shown?.question?.prompt).toEqual({ itemId: 'question-2', expectedRevision: 3 })
    )
    expect(shown?.session.itemNavigation?.pendingPrompt).toBe(true)
    const token = shown?.question?.optionTokens[0]
    if (!shown || !token) {
      throw new Error('The question did not offer an answer')
    }
    await act(async () => {
      await shown?.respondQuestion(token)
    })
    expect(
      sendRequest.mock.calls.find(([method]) => method === 'agentSession.respondToQuestion')?.[1]
    ).toMatchObject({ itemId: 'question-2', expectedRevision: 3, optionId: 'yes' })
  } finally {
    act(() => tree?.unmount())
  }
})
