import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'

const cursor = (sequence: number) => ({ epoch: 'epoch-1', sequence })
function page(sequence: number, child = false): AgentSessionHistoryPage {
  const row: AgentJournalRenderItem = {
    itemId: `row-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    ...(child ? { agentId: 'child' } : {}),
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'History' }] }
  }
  return {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    fence: 1,
    direction: 'before',
    items: [row],
    removedItemIds: [],
    submissions: [],
    hasOlder: true,
    hasNewer: false,
    window: { oldest: cursor(sequence), newest: cursor(sequence), nextCursor: cursor(sequence) }
  }
}
let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})

async function mount(latency: number, child = true) {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const reads: { cursor: number; timeout: number }[] = []
  let receive: ((value: unknown) => void) | undefined
  const sendRequest: RpcClient['sendRequest'] = async (method, params, options) => {
    if (method !== 'agentSession.history') {
      return { id: 'r', ok: true, result: {} }
    }
    if (
      !params ||
      typeof params !== 'object' ||
      !('cursor' in params) ||
      !params.cursor ||
      typeof params.cursor !== 'object' ||
      !('sequence' in params.cursor) ||
      typeof params.cursor.sequence !== 'number'
    ) {
      throw new Error('Missing history cursor')
    }
    const sequence = params.cursor.sequence
    const timeout = options?.timeoutMs ?? 15_000
    reads.push({ cursor: sequence, timeout })
    return new Promise<RpcResponse>((resolve, reject) => {
      setTimeout(
        () => {
          if (latency >= timeout) {
            reject(new Error('Request timed out: agentSession.history'))
          } else {
            resolve({ id: 'r', ok: true, result: { ok: true, page: page(sequence - 1, child) } })
          }
        },
        Math.min(latency, timeout)
      )
    })
  }
  const client: RpcClient = {
    sendRequest,
    subscribe: (_method, _params, callback) => {
      receive = callback
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
  let current: ReturnType<typeof useMobileStructuredAgentState> | undefined
  function Harness() {
    current = useMobileStructuredAgentState({
      client,
      sessionId: 'session-1',
      sessionKey: 'session-1',
      enabled: true,
      connected: true
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  act(() => receive?.({ type: 'snapshot', sessionId: 'session-1', fence: 1, page: page(1000) }))
  return {
    reads,
    hook: () => current,
    replaceHead: (sequence: number) =>
      act(() =>
        receive?.({
          type: 'snapshot',
          sessionId: 'session-1',
          fence: 1,
          page: page(sequence)
        })
      )
  }
}

it('bounds all child-only page reads by one deadline and keeps pages received before expiry', async () => {
  const { reads, hook } = await mount(4000)
  act(() => hook()?.loadEarlier())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  expect(hook()?.loadingOlder).toBe(false)
  expect(reads.map((read) => read.timeout)).toEqual([15_000, 11_000, 7_000, 3_000])
  expect(hook()?.state.items[0]?.sequence).toBe(997)
  expect(hook()?.state.status).toBe('ready')
})

it('does not start another read when the remaining deadline is below the existing RPC minimum', async () => {
  const { reads, hook } = await mount(4500)
  act(() => hook()?.loadEarlier())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
  expect(reads.map((read) => read.timeout)).toEqual([15_000, 10_500, 6_000])
  expect(hook()?.loadingOlder).toBe(false)
  expect(hook()?.state.items[0]?.sequence).toBe(997)
})

it('shares the same deadline with a retry after the live stream moves the history anchor', async () => {
  const { reads, hook, replaceHead } = await mount(8000, false)
  act(() => hook()?.loadEarlier())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  replaceHead(2000)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14_000)
  })
  expect(reads).toEqual([
    { cursor: 1000, timeout: 15_000 },
    { cursor: 2000, timeout: 7000 }
  ])
  expect(hook()?.loadingOlder).toBe(false)
  expect(hook()?.state.items[0]?.sequence).toBe(2000)
})
