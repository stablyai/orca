import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { AgentSessionExecutionView } from '../../../src/shared/agent-session-execution-view'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'

let renderer: ReactTestRenderer | undefined
let latest: ReturnType<typeof useMobileStructuredAgentState> | undefined
const callbacks: ((event: unknown) => void)[] = []
const client: RpcClient = {
  sendRequest: async () => ({ id: 'request', ok: true, result: {}, _meta: { runtimeId: 'host' } }),
  subscribe: (_method, _params, callback) => {
    callbacks.push(callback)
    return vi.fn()
  },
  close: vi.fn(),
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => 1,
  notifyForeground: vi.fn(),
  onStateChange: () => vi.fn(),
  updateTerminalSubscriptionViewport: vi.fn()
}
function Harness({ connected }: { connected: boolean }) {
  latest = useMobileStructuredAgentState({
    client,
    sessionId: 'session',
    sessionKey: 'host:session',
    enabled: true,
    connected
  })
  return null
}
const execution: AgentSessionExecutionView = {
  sessionId: 'session',
  location: {
    executionHostId: 'local',
    workspaceId: 'folder',
    workspaceKind: 'folder',
    wslDistro: null
  },
  hostIncarnation: 'new-host',
  revision: 1,
  fence: 1,
  cursor: { epoch: 'epoch', sequence: 1 },
  observation: 'live',
  activity: 'working',
  control: 'native',
  turnId: 'turn',
  promptIds: [],
  recovery: false,
  historicalStatus: 'working'
}
function snapshot(includeExecution: boolean): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session',
    fence: 1,
    ...(includeExecution ? { execution } : {}),
    page: {
      sessionId: 'session',
      epoch: 'epoch',
      direction: 'tail',
      items: [
        {
          itemId: 'message',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'retained transcript' }]
          }
        }
      ],
      submissions: [],
      removedItemIds: [],
      window: { oldest: execution.cursor, newest: execution.cursor, nextCursor: execution.cursor },
      liveCursor: execution.cursor,
      hasNewer: false,
      hasOlder: false
    }
  }
}
afterEach(() => {
  act(() => renderer?.unmount())
  callbacks.length = 0
})

it('revokes mobile execution on disconnect and never restores it from retired callbacks or an older host', async () => {
  await act(async () => {
    renderer = create(createElement(Harness, { connected: true }))
  })
  const retired = callbacks[0]
  act(() => retired(snapshot(true)))
  expect(latest?.state.execution?.control).toBe('native')
  await act(async () => {
    renderer?.update(createElement(Harness, { connected: false }))
  })
  expect(latest?.state.status).toBe('loading')
  expect(latest?.state.execution).toBeUndefined()
  expect(latest?.state.items).toHaveLength(1)
  act(() => retired(snapshot(true)))
  expect(latest?.state.execution).toBeUndefined()
  await act(async () => {
    renderer?.update(createElement(Harness, { connected: true }))
  })
  act(() => callbacks[1](snapshot(false)))
  expect(latest?.state.status).toBe('ready')
  expect(latest?.state.execution).toBeUndefined()
  expect(latest?.state.items).toHaveLength(1)
})

it('fences further frames after a mobile session stream ends', async () => {
  await act(async () => {
    renderer = create(createElement(Harness, { connected: true }))
  })
  act(() => callbacks[0](snapshot(true)))
  act(() => callbacks[0]({ type: 'end' }))
  expect(latest?.state.execution).toBeUndefined()
  act(() => callbacks[0](snapshot(true)))
  expect(latest?.state.execution).toBeUndefined()
})
