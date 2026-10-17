import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'

const cursor = (sequence: number) => ({ epoch: 'epoch-1', sequence })
const row = (sequence: number): AgentJournalRenderItem => ({
  itemId: `row-${sequence}`,
  revision: 1,
  sequence,
  observedAt: sequence,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'x'.repeat(5000) }] }
})
function page(items: AgentJournalRenderItem[]): AgentSessionHistoryPage {
  return {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    fence: 1,
    direction: 'before',
    items,
    removedItemIds: [],
    submissions: [],
    hasOlder: true,
    hasNewer: false,
    window: {
      oldest: cursor(items[0]!.sequence),
      newest: cursor(items.at(-1)!.sequence),
      nextCursor: cursor(items[0]!.sequence)
    }
  }
}
it('loads older tool-sized messages within the read deadline on a constrained link', async () => {
  vi.useFakeTimers()
  let renderer: ReactTestRenderer | undefined
  const deadlines: number[] = []
  const sendRequest: RpcClient['sendRequest'] = async (method, params, options) => {
    if (method !== 'agentSession.history') {
      return { id: 'r', ok: true, result: {} }
    }
    if (
      !params ||
      typeof params !== 'object' ||
      !('limit' in params) ||
      typeof params.limit !== 'number'
    ) {
      throw new Error('Missing history page size')
    }
    const limit = params.limit
    const older = page(Array.from({ length: limit }, (_, i) => row(1000 - limit + i)))
    const timeout = options?.timeoutMs ?? 15_000
    const delivery = Math.ceil((JSON.stringify(older).length * 1000) / (50 * 1024))
    deadlines.push(delivery)
    return new Promise<RpcResponse>((resolve, reject) =>
      setTimeout(
        () => {
          if (delivery >= timeout) {
            reject(new Error('Request timed out: agentSession.history'))
          } else {
            resolve({ id: 'r', ok: true, result: { ok: true, page: older } })
          }
        },
        Math.min(delivery, timeout)
      )
    )
  }
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const subscribe = vi.spyOn(client, 'subscribe')
  let receive: ((value: unknown) => void) | undefined
  subscribe.mockImplementation((_method, _params, callback) => {
    receive = callback
    return () => {}
  })
  let hook: ReturnType<typeof useMobileStructuredAgentState> | undefined
  function Harness() {
    hook = useMobileStructuredAgentState({
      client,
      sessionId: 'session-1',
      sessionKey: 'session-1',
      enabled: true,
      connected: true
    })
    return null
  }
  try {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    act(() =>
      receive?.({ type: 'snapshot', sessionId: 'session-1', fence: 1, page: page([row(1000)]) })
    )
    act(() => hook?.loadEarlier())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(deadlines).toHaveLength(1)
    expect(deadlines[0]).toBeLessThan(15_000)
    expect(hook?.state.items[0]?.sequence).toBeLessThan(1000)
    expect(hook?.state.status).toBe('ready')
  } finally {
    act(() => renderer?.unmount())
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})
