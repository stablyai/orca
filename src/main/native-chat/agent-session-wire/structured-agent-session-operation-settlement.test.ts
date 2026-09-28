import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AgentSessionPreDispatchError,
  runSettledAgentSessionMutation
} from './structured-agent-session-operation-settlement'
import {
  adapter,
  envelope,
  hostTestState,
  journals
} from './structured-agent-session-host-test-harness'
import {
  hostTestMessage,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { sendPlan } from './structured-agent-session-mutation-plans'

async function context(): Promise<AgentSessionTurnContext> {
  return {
    sessionId: SESSION,
    journal: await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: THREAD }
      },
      journalDir: join(hostTestState().root, 'settlement')
    }),
    fence: 1,
    adapter: adapter(),
    persistOptions: async () => {},
    resolvedBy: 'test',
    publish: () => {},
    flushStreamedEvents: async () => {},
    now: () => 0
  }
}

/** Longer than any bookkeeping bound: a refusal must already be answered by then. */
const SETTLED_WAIT_MS = 2_000

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('returns a pre-dispatch refusal without waiting on redundant uncertainty persistence', async () => {
  const ctx = await context()
  const { store } = hostTestState()
  const stalled = Promise.withResolvers<void>()
  const refusing = Promise.withResolvers<void>()
  const writes = vi
    .spyOn(store, 'recordOperationOutcome')
    .mockResolvedValueOnce()
    .mockImplementation(() => stalled.promise)
  const refusal = new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  let returned = false
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const result = runSettledAgentSessionMutation({
    store,
    operationCallerKey: 'test',
    envelope: envelope('agentSession.send', {}),
    context: ctx,
    plan: {
      method: 'agentSession.send',
      fields: {},
      markUnknownBeforeRun: true,
      run: async () => {
        refusing.resolve()
        throw refusal
      },
      replay: () => null
    }
  }).catch((error: unknown) => {
    returned = true
    return error
  })
  try {
    await refusing.promise
    await vi.advanceTimersByTimeAsync(SETTLED_WAIT_MS)
    expect(returned).toBe(true)
    expect(writes).toHaveBeenCalledOnce()
    expect(hostTestState().dispatch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    stalled.resolve()
    expect(await result).toBe(refusal)
  }
})

it.each([1, 2])(
  'preserves a proven refusal through %s failed bookkeeping writes',
  async (failures) => {
    const ctx = await context()
    const { store, dispatch } = hostTestState()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let writes = 0
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async () => {
      writes += 1
      if (writes > 1 && writes <= failures + 1) {
        throw new Error('private unbounded disk detail')
      }
    })
    const refusal = {
      ok: false as const,
      refusal: { code: 'agent_session_operation_invalid' as const, message: 'Not sent.' }
    }
    const run = vi.fn(async () => refusal)
    const result = await runSettledAgentSessionMutation({
      store,
      operationCallerKey: 'test',
      envelope: envelope('agentSession.send', {}),
      context: ctx,
      plan: {
        method: 'agentSession.send',
        fields: {},
        markUnknownBeforeRun: true,
        run,
        replay: () => null
      }
    })
    expect(result).toEqual(refusal)
    expect(run).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled()
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private unbounded disk detail')
  }
)

// A send's plan only accepts: it records the submission and never waits on the provider's stream
// barrier, so a sink that stalls or fails cannot delay or double a send. Handing it over is the
// delivery loop's.
it('accepts without touching the event-stream barrier or the provider', async () => {
  const ctx = await context()
  const { store } = hostTestState()
  vi.spyOn(store, 'recordOperationOutcome').mockResolvedValue()
  const barrier = vi.fn(() => new Promise<void>(() => {}))
  ctx.flushStreamedEvents = barrier
  const beforeRun = vi.fn()
  const body = hostTestMessage('Continue the interrupted work')
  const operation = envelope('agentSession.send', { body })
  const result = await runSettledAgentSessionMutation({
    store,
    operationCallerKey: 'test',
    envelope: operation,
    context: ctx,
    plan: sendPlan({ envelope: operation, body, beforeRun })
  })
  expect(result).toMatchObject({ ok: true })
  expect(beforeRun).toHaveBeenCalledOnce()
  expect(hostTestState().dispatch).not.toHaveBeenCalled()
  expect(ctx.journal.submissions()[0]).toMatchObject({
    dispatchState: 'pending',
    handoverRecorded: true
  })
  expect(barrier).not.toHaveBeenCalled()
})

it('refuses a superseded send at acceptance, recording and dispatching nothing', async () => {
  const ctx = await context()
  const { store } = hostTestState()
  vi.spyOn(store, 'recordOperationOutcome').mockResolvedValue()
  const beforeRun = vi.fn(() => {
    throw new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  })
  const body = hostTestMessage('Continue the interrupted work')
  const operation = envelope('agentSession.send', { body })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const result = await runSettledAgentSessionMutation({
    store,
    operationCallerKey: 'test',
    envelope: operation,
    context: ctx,
    plan: sendPlan({ envelope: operation, body, beforeRun })
  }).catch((error: unknown) => error)
  expect(result).toBeInstanceOf(AgentSessionPreDispatchError)
  expect(ctx.journal.submissions()).toEqual([])
  expect(hostTestState().dispatch).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
