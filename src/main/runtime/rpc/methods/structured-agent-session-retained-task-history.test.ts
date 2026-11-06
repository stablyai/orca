import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionBackgroundTaskState } from '../../../../shared/agent-session/agent-session-background-task-wire'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import { AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY } from '../../../../shared/agent-session/agent-session-background-task-child-views-capability'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import type { AgentSessionSubscribeInput } from '../../../native-chat/agent-session-wire/structured-agent-session-subscribers'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

const CURRENT_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: remoteRuntimeClientCapabilities(STRUCTURED_CLIENT.clientCapabilities)
}
/** Understands a stopless roster, but predates per-row stoppability. */
const STOP_ONLY_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: remoteRuntimeClientCapabilities(STRUCTURED_CLIENT.clientCapabilities).filter(
    (capability) => capability !== AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY
  )
}
const FOREGROUND_ROW = { id: 'fore', kind: 'agent', stoppable: false } as const

describe('retained task history at the RPC boundary', () => {
  const view = (membership: 'live' | 'settled'): AgentChildWorkView => ({
    id: `child-${membership}`,
    providerId: `task-${membership}`,
    kind: 'agent',
    state: membership === 'live' ? 'working' : 'done',
    membership,
    ...(membership === 'settled' ? { outcome: 'succeeded' as const, settledAt: 2 } : {}),
    firstObservedAt: 1,
    observedAt: 2,
    stoppable: true,
    invocation: { invocationId: `toolu-${membership}`, generation: 1 }
  })
  const LIVE_ROW = { id: 'task-live', kind: 'agent', state: 'working' } as const
  const SETTLED_ROW = { id: 'task-settled', kind: 'agent', state: 'done' } as const
  /** Predates child views: reads any roster as live work. */
  const PRE_VIEWS_CLIENT = {
    ...STRUCTURED_CLIENT,
    clientCapabilities: remoteRuntimeClientCapabilities(
      STRUCTURED_CLIENT.clientCapabilities
    ).filter((capability) => capability !== AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY)
  }

  async function historyFor(
    backgroundTasks: AgentSessionBackgroundTaskState,
    client: Parameters<typeof call>[2]
  ) {
    hostCalls.history.mockReturnValue({ ok: true, page: { items: [], backgroundTasks } })
    return call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, client)
  }

  const settledOnly: AgentSessionBackgroundTaskState = {
    state: 'monitoring',
    supportsTaskStop: true,
    settledTasks: [SETTLED_ROW],
    children: [view('settled')]
  }

  it('retains readable settled task history while omitting unsupported child views', async () => {
    expect(await historyFor(settledOnly, PRE_VIEWS_CLIENT)).toMatchObject({
      ok: true,
      result: {
        page: {
          backgroundTasks: {
            state: 'monitoring',
            supportsTaskStop: true,
            settledTasks: [SETTLED_ROW]
          }
        }
      }
    })
    for (const client of [CURRENT_CLIENT, undefined]) {
      expect(await historyFor(settledOnly, client)).toMatchObject({
        ok: true,
        result: { page: { backgroundTasks: settledOnly } }
      })
    }
    expect(settledOnly.children).toHaveLength(1)
  })

  it('preserves readable settled tasks on subscriptions for older readers', async () => {
    hostCalls.subscribe.mockImplementation((input: AgentSessionSubscribeInput) => {
      input.emit({
        type: 'batch',
        sessionId: SESSION,
        fence: 1,
        backgroundTasks: settledOnly,
        batch: {
          cursor: { epoch: 'a', sequence: 0 },
          items: [],
          removedItemIds: [],
          submissions: []
        }
      })
      return () => {}
    })
    for (const [client, expected] of [
      [
        PRE_VIEWS_CLIENT,
        { state: 'monitoring', supportsTaskStop: true, settledTasks: [SETTLED_ROW] }
      ],
      [CURRENT_CLIENT, settledOnly]
    ] as const) {
      expect(await call('agentSession.subscribe', { sessionId: SESSION }, client)).toMatchObject({
        ok: true,
        result: { type: 'batch', backgroundTasks: expected }
      })
    }
  })

  it('withholds a settled-only child view when an older reader has no readable task rows', async () => {
    const { settledTasks: _tasks, ...unreadable } = settledOnly
    expect(await historyFor(unreadable, PRE_VIEWS_CLIENT)).toMatchObject({
      ok: true,
      result: { page: { backgroundTasks: null } }
    })
  })

  it.each([
    { ...settledOnly, incomplete: true as const },
    { ...settledOnly, tasks: [LIVE_ROW] },
    { ...settledOnly, children: [view('live'), view('settled')] },
    { state: 'monitoring' as const }
  ])(
    'retains incomplete, live and pre-producer states for older readers: %j',
    async (state: AgentSessionBackgroundTaskState) => {
      const { children: _children, ...legacy } = state
      expect(await historyFor(state, PRE_VIEWS_CLIENT)).toMatchObject({
        ok: true,
        result: { page: { backgroundTasks: legacy } }
      })
    }
  )

  it('retains settled tasks when a pre-row-stop reader filters its last unstoppable live row', async () => {
    const state: AgentSessionBackgroundTaskState = {
      state: 'monitoring',
      supportsTaskStop: true,
      tasks: [FOREGROUND_ROW],
      settledTasks: [SETTLED_ROW]
    }
    expect(await historyFor(state, STOP_ONLY_CLIENT)).toMatchObject({
      ok: true,
      result: { page: { backgroundTasks: { ...state, tasks: [] } } }
    })
  })
})
