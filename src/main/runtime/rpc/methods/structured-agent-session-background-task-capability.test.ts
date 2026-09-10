import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTaskState } from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY } from '../../../../shared/protocol-version'
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
