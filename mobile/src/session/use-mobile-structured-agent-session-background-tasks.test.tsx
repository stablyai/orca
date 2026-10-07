// The running child work a structured session publishes reaches the phone's strip: desktop's view
// of the same roster, rows that stop claiming live work once the stream is lost, and a Stop that
// reaches the host's background-task cancel.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../src/shared/agent-status-child-work-view'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { resetMobileStructuredSendOperationJournalForTests } from './mobile-structured-send-operation-journal'
import {
  backgroundTaskRowMeta,
  buildBackgroundTaskGroupsFromViews
} from '../../../src/shared/background-task-roster'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  batchEvent,
  CAPABLE,
  fieldsOf,
  mutationOk,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

function childView(id: string): AgentChildWorkView {
  return {
    id,
    providerId: `task-${id}`,
    kind: 'agent',
    description: `review ${id}`,
    state: 'working',
    membership: 'live',
    firstObservedAt: 1_000,
    observedAt: 2_000,
    stoppable: true,
    invocation: { invocationId: `spawn-${id}`, generation: 1 }
  }
}

function withChildren(hostNow?: number): AgentSessionSubscribeEvent {
  const snapshot = snapshotEvent()
  return snapshot.type === 'snapshot'
    ? {
        ...snapshot,
        ...(hostNow !== undefined ? { hostNow } : {}),
        backgroundTasks: {
          state: 'monitoring',
          supportsTaskStop: true,
          children: [childView('a'), childView('b')]
        }
      }
    : snapshot
}

describe('mobile structured session background tasks', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  let listener: ((value: unknown) => void) | null = null
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const onSendError = vi.fn()
  const client: RpcClient = {
    sendRequest,
    subscribe: (_method, _params, onData) => {
      listener = onData
      return vi.fn()
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }

  function Harness({ connected }: { connected: boolean }): null {
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected,
      agent: 'claude',
      hostSupport: CAPABLE,
      onSendError
    })
    return null
  }

  async function mount(event: AgentSessionSubscribeEvent): Promise<void> {
    act(() => {
      renderer = create(createElement(Harness, { connected: true }))
    })
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
    act(() => listener?.(event))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileStructuredSendOperationJournalForTests()
    sendRequest.mockImplementation(async (method) =>
      method === 'agentSession.cancel'
        ? mutationOk({})
        : method === 'agentSession.options'
          ? ok({ models: [], current: {} })
          : ok({})
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
    listener = null
  })

  it('returns the running children the host publishes, with live rows while the stream is', async () => {
    await mount(withChildren())
    const tasks = hook?.backgroundTasks
    expect(tasks?.view.show).toBe(true)
    expect(tasks?.view.supportsStop).toBe(true)
    expect(tasks?.view.children?.map((view) => view.id)).toEqual(['a', 'b'])
    expect(tasks?.rowContext.transportObservation).toBe('live')
  })

  it('shows no strip for a host that reports nothing running', async () => {
    await mount(snapshotEvent())
    expect(hook?.backgroundTasks.view.show).toBe(false)
  })

  it('keeps the roster but stops claiming live work once the connection drops', async () => {
    await mount(withChildren())
    act(() => renderer?.update(createElement(Harness, { connected: false })))
    expect(hook?.backgroundTasks.view.children).toHaveLength(2)
    expect(hook?.backgroundTasks.rowContext.transportObservation).toBe('unverifiable')
  })

  function stripElapsed(): string {
    const tasks = hook!.backgroundTasks
    const [group] = buildBackgroundTaskGroupsFromViews(tasks.view.children ?? [], tasks.rowContext)
    // The strip reads host-stamped clocks on the host's clock: the phone's now less the offset.
    return backgroundTaskRowMeta(
      group!.tasks[0]!.row,
      Date.now() - tasks.rowContext.hostClockOffsetMs
    )
  }

  it('keeps the rows on a jitter-only frame and re-derives a shifted host clock', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    await mount(withChildren(40_000))
    const first = hook?.backgroundTasks
    expect(first?.rowContext.hostClockOffsetMs).toBe(60_000)
    // Child first seen at host time 1_000; host now is 40_000.
    expect(stripElapsed()).toBe('39s')

    // A later sample whose delivery took 300 ms longer: the same offset once rounded.
    const jitter = batchEvent()
    act(() => listener?.(jitter.type === 'batch' ? { ...jitter, hostNow: 39_700 } : jitter))
    expect(hook?.backgroundTasks).toBe(first)

    // The host's clock jumped forward 20 s (a restart or correction): every elapsed moves with it.
    act(() => listener?.(withChildren(60_000)))
    expect(hook?.backgroundTasks.rowContext.hostClockOffsetMs).toBe(40_000)
    expect(stripElapsed()).toBe('59s')
    clock.mockRestore()
  })

  it("stops one child through the host's background-task cancel", async () => {
    await mount(withChildren())
    await act(async () => {
      await hook?.backgroundTasks.stop('task-a')
    })
    const cancel = sendRequest.mock.calls.find(([method]) => method === 'agentSession.cancel')
    expect(fieldsOf(cancel?.[1])).toMatchObject({
      turnId: 'background-tasks',
      scope: 'background-tasks',
      taskId: 'task-a'
    })
  })
})
