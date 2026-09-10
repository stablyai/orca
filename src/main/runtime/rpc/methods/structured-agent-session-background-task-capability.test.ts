import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTaskState } from '../../../../shared/agent-session-wire'
import {
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY
} from '../../../../shared/protocol-version'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
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

const TASKS: AgentSessionBackgroundTaskState = {
  state: 'monitoring',
  supportsStopAll: false,
  tasks: [{ id: 'child', kind: 'agent' }]
}
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
const BACKGROUNDED_ROW = { id: 'back', kind: 'agent' } as const
const MIXED_ROWS: AgentSessionBackgroundTaskState = {
  state: 'monitoring',
  supportsTaskStop: true,
  tasks: [FOREGROUND_ROW, BACKGROUNDED_ROW]
}

describe('background-task stop capability at the RPC boundary', () => {
  it('advertises reader support on remote requests and subscriptions', () => {
    expect(CURRENT_CLIENT.clientCapabilities).toContain(
      AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY
    )
  })

  it.each([
    ['legacy reader', STRUCTURED_CLIENT, null],
    ['current reader', CURRENT_CLIENT, TASKS],
    ['in-process reader', undefined, TASKS]
  ] as const)('projects history for a %s', async (_label, client, expected) => {
    hostCalls.history.mockReturnValue({ ok: true, page: { items: [], backgroundTasks: TASKS } })
    expect(
      await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, client)
    ).toMatchObject({ ok: true, result: { page: { backgroundTasks: expected } } })
  })

  it.each(['snapshot', 'batch', 'reset'] as const)(
    'gates the %s stream without changing the provider state',
    async (type) => {
      hostCalls.hold = vi.fn(async () => undefined)
      hostCalls.subscribe.mockImplementation((input: AgentSessionSubscribeInput) => {
        const base = { sessionId: SESSION, fence: 1, backgroundTasks: TASKS }
        if (type === 'batch') {
          input.emit({
            ...base,
            type,
            batch: {
              cursor: { epoch: 'a', sequence: 0 },
              items: [],
              removedItemIds: [],
              submissions: []
            }
          })
        } else {
          const page = {
            sessionId: SESSION,
            epoch: 'a',
            direction: 'tail' as const,
            items: [],
            removedItemIds: [],
            submissions: [],
            window: { oldest: null, newest: null, nextCursor: { epoch: 'a', sequence: 0 } },
            hasOlder: false,
            hasNewer: false
          }
          input.emit(
            type === 'snapshot'
              ? { ...base, type, page }
              : { ...base, type, page, reset: 'epoch_changed' }
          )
        }
        return () => {}
      })
      for (const [client, expected] of [
        [STRUCTURED_CLIENT, null],
        [CURRENT_CLIENT, TASKS]
      ] as const) {
        expect(await call('agentSession.subscribe', { sessionId: SESSION }, client)).toMatchObject({
          ok: true,
          result: { type, backgroundTasks: expected }
        })
      }
      expect(TASKS.supportsStopAll).toBe(false)
    }
  )

  it('advertises row-stop support separately from stop support', () => {
    // A client can advertise the stop capability and still predate `stoppable`,
    // so the two must not be conflated.
    expect(CURRENT_CLIENT.clientCapabilities).toContain(
      AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY
    )
    expect(STOP_ONLY_CLIENT.clientCapabilities).not.toContain(
      AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY
    )
  })

  it.each([
    ['row-stop reader', () => CURRENT_CLIENT, MIXED_ROWS],
    [
      'stop-only reader',
      () => STOP_ONLY_CLIENT,
      { state: 'monitoring', tasks: [BACKGROUNDED_ROW] }
    ],
    ['in-process reader', () => undefined, MIXED_ROWS]
  ] as const)('projects unstoppable rows for a %s', async (_label, client, expected) => {
    hostCalls.history.mockReturnValue({
      ok: true,
      page: { items: [], backgroundTasks: MIXED_ROWS }
    })
    expect(
      await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, client())
    ).toMatchObject({ ok: true, result: { page: { backgroundTasks: expected } } })
  })

  it('hands a reader that predates the field no strip when every row is unstoppable', async () => {
    // Its pre-feature view exactly: the host published no foreground rows at all.
    const foregroundOnly = {
      state: 'monitoring' as const,
      supportsTaskStop: true,
      tasks: [{ id: 'fore', kind: 'agent' as const, stoppable: false }]
    }
    hostCalls.history.mockReturnValue({
      ok: true,
      page: { items: [], backgroundTasks: foregroundOnly }
    })
    expect(
      await call(
        'agentSession.history',
        { sessionId: SESSION, direction: 'tail' },
        STOP_ONLY_CLIENT
      )
    ).toMatchObject({ ok: true, result: { page: { backgroundTasks: null } } })
    expect(
      await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, CURRENT_CLIENT)
    ).toMatchObject({ ok: true, result: { page: { backgroundTasks: foregroundOnly } } })
  })

  it('preserves legacy stoppable state for both readers', async () => {
    const stoppable = { state: 'monitoring', tasks: TASKS.tasks }
    hostCalls.history.mockReturnValue({ ok: true, page: { items: [], backgroundTasks: stoppable } })
    for (const client of [STRUCTURED_CLIENT, CURRENT_CLIENT]) {
      expect(
        await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, client)
      ).toMatchObject({ ok: true, result: { page: { backgroundTasks: stoppable } } })
    }
  })
})
