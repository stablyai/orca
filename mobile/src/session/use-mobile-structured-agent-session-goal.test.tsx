import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../src/shared/agent-session-journal-types'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  CAPABLE,
  fieldsOf,
  mutationOk,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

const goal: AgentJournalThreadGoal = {
  objective: 'Finish the mobile goal regression',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 500,
  timeUsedSeconds: 67,
  createdAt: 1_000,
  updatedAt: 10_000
}
function goalRow(sequence: number, value: AgentJournalThreadGoal | null): AgentJournalRenderItem {
  return {
    itemId: `goal-${sequence}`,
    revision: 1,
    sequence,
    observedAt: 10_000,
    body: {
      kind: 'status',
      text: 'Goal changed',
      threadGoal: value ? { state: 'set', goal: value } : { state: 'cleared' }
    }
  }
}

describe('mobile structured goal visibility', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  let generation = 1
  const onSendError = vi.fn()
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client: RpcClient = {
    sendRequest,
    subscribe: (_method, _params, onData) => {
      listener = onData
      return vi.fn()
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getGeneration: () => generation,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  function Harness({
    sessionId = 'session-1',
    sourceIdentity = 'host-a\0folder-a',
    connected = true
  }: {
    sessionId?: string
    sourceIdentity?: string
    connected?: boolean
  }): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId,
      sourceIdentity,
      enabled: true,
      connected,
      agent: 'codex',
      hostSupport: CAPABLE,
      onSendError
    })
    return null
  }
  async function mount(items: AgentJournalRenderItem[] = []): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(snapshotEvent({ items })))
  }
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    listener = null
    generation = 1
    vi.clearAllMocks()
  })

  it('exposes the current host goal even when its journal row is outside the loaded page', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, threadGoal: { current: goal } })
        : ok({})
    )
    await mount()
    await vi.waitFor(() => expect(hook).toHaveProperty('threadGoal.goal', goal))
  })

  it('uses the newest root transition, clears it, and ignores child goals', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, threadGoal: { current: goal } })
        : ok({})
    )
    await mount([
      goalRow(1, { ...goal, status: 'paused' }),
      { ...goalRow(2, goal), agentId: 'child-1' }
    ])
    await vi.waitFor(() => expect(hook).toHaveProperty('threadGoal.goal.status', 'paused'))
    act(() => listener?.(snapshotEvent({ items: [goalRow(3, null)] })))
    expect(hook).toHaveProperty('threadGoal', null)
  })

  it('honors the reported context floor without reviving an older loaded goal', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({
            models: [],
            current: {},
            threadGoal: { current: null, contextFloor: { epoch: 'epoch-1', sequence: 2 } }
          })
        : ok({})
    )
    await mount([goalRow(1, goal)])
    await vi.waitFor(() => expect(hook).toHaveProperty('threadGoalReport.contextFloor.sequence', 2))
    expect(hook).toHaveProperty('threadGoal', null)
    act(() => listener?.(snapshotEvent({ items: [goalRow(3, { ...goal, status: 'blocked' })] })))
    expect(hook).toHaveProperty('threadGoal.goal.status', 'blocked')
  })

  it('keeps a reported-only goal through disconnection without claiming it is running', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, reportedThreadGoal: { current: goal } })
        : ok({})
    )
    await mount()
    await vi.waitFor(() => expect(hook).toHaveProperty('threadGoal.goal', goal))
    await act(async () => renderer?.update(createElement(Harness, { connected: false })))
    expect(hook).toHaveProperty('threadGoal.goal', goal)
    expect(hook).toHaveProperty('threadGoal.runningTurn', null)
  })

  it('does not leak a goal into another host/workspace with the same session id', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, threadGoal: { current: goal } })
        : ok({})
    )
    await mount()
    await vi.waitFor(() => expect(hook).toHaveProperty('threadGoal.goal', goal))
    let resolveOptions: ((value: ReturnType<typeof ok>) => void) | undefined
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? new Promise((resolve) => {
            resolveOptions = resolve
          })
        : ok({})
    )
    await act(async () =>
      renderer?.update(createElement(Harness, { sourceIdentity: 'host-b\0folder-b' }))
    )
    expect(hook).toHaveProperty('threadGoal', null)
    await act(async () => resolveOptions?.(ok({ models: [], current: {} })))
    expect(hook).toHaveProperty('threadGoal', null)
  })

  it('does not invent goal support for an older host that omits the report', async () => {
    sendRequest.mockImplementation(async () => ok({ models: [], current: {} }))
    await mount([goalRow(1, goal)])
    expect(hook).toHaveProperty('threadGoal', null)
  })

  it.each([
    { kind: 'clear' },
    { kind: 'status', status: 'paused' },
    { kind: 'status', status: 'active' }
  ] as const)('changes the host goal through the fenced mutation: %j', async (change) => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, threadGoal: { current: goal } })
        : mutationOk({ change: change.kind })
    )
    await mount()
    await vi.waitFor(() => expect(hook?.threadGoal?.controls).toBeDefined())
    const readsBefore = sendRequest.mock.calls.filter(
      ([method]) => method === 'agentSession.options'
    ).length
    await act(async () => expect(await hook?.threadGoal?.controls?.change(change)).toBe(true))
    const request = sendRequest.mock.calls.find(([method]) => method === 'agentSession.threadGoal')
    expect(fieldsOf(request?.[1])).toMatchObject({
      envelope: { sessionId: 'session-1', expectedRuntimeFence: 3 },
      change
    })
    expect(hook?.threadGoal?.goal).toEqual(goal)
    expect(
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.options').length
    ).toBeGreaterThan(readsBefore)
  })

  it('keeps reported-only goals readable without offering unsupported writes', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, reportedThreadGoal: { current: goal } })
        : ok({})
    )
    await mount()
    await vi.waitFor(() => expect(hook?.threadGoal?.goal).toEqual(goal))
    expect(hook?.threadGoal?.controls).toBeUndefined()
    expect(sendRequest.mock.calls.some(([method]) => method === 'agentSession.threadGoal')).toBe(
      false
    )
  })

  it('blocks repeated taps, reports unknown delivery, and never replays a goal change', async () => {
    let finish: ((value: ReturnType<typeof ok>) => void) | undefined
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, threadGoal: { current: goal } })
        : method === 'agentSession.threadGoal'
          ? new Promise((resolve) => {
              finish = resolve
            })
          : ok({})
    )
    await mount()
    await vi.waitFor(() => expect(hook?.threadGoal?.controls).toBeDefined())
    let first: Promise<boolean> | undefined
    await act(async () => {
      first = hook?.threadGoal?.controls?.change({ kind: 'clear' })
      expect(await hook?.threadGoal?.controls?.change({ kind: 'clear' })).toBe(false)
    })
    expect(hook?.threadGoal?.controls?.pending).toBe(true)
    await act(async () =>
      finish?.({ id: 'goal', ok: false, error: { code: 'transport_timeout', message: 'timeout' } })
    )
    expect(await first).toBe(false)
    expect(onSendError).toHaveBeenCalledWith("Orca couldn't confirm what happened. Check the chat.")
    expect(hook?.threadGoal?.goal).toEqual(goal)
    expect(hook?.threadGoal?.controls?.pending).toBe(false)
    expect(
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.threadGoal')
    ).toHaveLength(1)
  })

  it('rejects a retained action after host or connection cutover', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, threadGoal: { current: goal } })
        : ok({})
    )
    await mount()
    await vi.waitFor(() => expect(hook?.threadGoal?.controls).toBeDefined())
    const retained = hook?.threadGoal?.controls?.change
    await act(async () => renderer?.update(createElement(Harness, { connected: false })))
    expect(hook?.threadGoal?.controls?.disabled).toBe(true)
    await act(async () => expect(await retained?.({ kind: 'clear' })).toBe(false))
    await act(async () => renderer?.update(createElement(Harness, { sourceIdentity: 'host-b' })))
    await act(async () => expect(await retained?.({ kind: 'clear' })).toBe(false))
    expect(sendRequest.mock.calls.some(([method]) => method === 'agentSession.threadGoal')).toBe(
      false
    )
  })

  it('refreshes an acknowledged clear without reviving an older journal goal', async () => {
    let cleared = false
    sendRequest.mockImplementation(async (method) => {
      if (method === 'agentSession.options') {
        return ok({
          models: [],
          current: {},
          threadGoal: {
            current: cleared ? null : goal,
            source: { epoch: 'epoch-1', sequence: cleared ? 2 : 1, revision: 1 }
          }
        })
      }
      if (method === 'agentSession.threadGoal') {
        cleared = true
        return mutationOk({ change: 'clear' })
      }
      return ok({})
    })
    await mount([goalRow(1, goal)])
    await vi.waitFor(() => expect(hook?.threadGoal?.controls).toBeDefined())
    await act(async () =>
      expect(await hook?.threadGoal?.controls?.change({ kind: 'clear' })).toBe(true)
    )
    expect(hook?.threadGoal).toBeNull()
    expect(hook?.session.threadGoal).toBeNull()
  })

  it('does not settle an old-host write into the replacement session', async () => {
    let finish: ((value: ReturnType<typeof ok>) => void) | undefined
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, threadGoal: { current: goal } })
        : method === 'agentSession.threadGoal'
          ? new Promise((resolve) => {
              finish = resolve
            })
          : ok({})
    )
    await mount()
    await vi.waitFor(() => expect(hook?.threadGoal?.controls).toBeDefined())
    let pending: Promise<boolean> | undefined
    await act(async () => {
      pending = hook?.threadGoal?.controls?.change({ kind: 'clear' })
    })
    await act(async () => renderer?.update(createElement(Harness, { sourceIdentity: 'host-b' })))
    await vi.waitFor(() => expect(hook?.threadGoal?.controls).toBeDefined())
    expect(hook?.threadGoal?.controls?.pending).toBe(false)
    const readsBefore = sendRequest.mock.calls.filter(
      ([method]) => method === 'agentSession.options'
    ).length
    await act(async () => finish?.(mutationOk({ change: 'clear' })))
    expect(await pending).toBe(false)
    expect(hook?.threadGoal?.goal).toEqual(goal)
    expect(onSendError).not.toHaveBeenCalled()
    expect(
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.options')
    ).toHaveLength(readsBefore)
  })

  it('fences a retained goal action when the logical connection changes before rerender', async () => {
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.options'
        ? ok({ models: [], current: {}, threadGoal: { current: goal } })
        : ok({})
    )
    await mount()
    await vi.waitFor(() => expect(hook?.threadGoal?.controls).toBeDefined())
    const retained = hook?.threadGoal?.controls?.change
    generation += 1
    await act(async () => expect(await retained?.({ kind: 'clear' })).toBe(false))
    expect(hook?.threadGoal?.goal).toEqual(goal)
    expect(sendRequest.mock.calls.some(([method]) => method === 'agentSession.threadGoal')).toBe(
      false
    )
  })
})
