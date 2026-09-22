import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AgentSessionPreDispatchError,
  AGENT_SESSION_ADMISSION_BARRIER_TIMEOUT_MS,
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
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_ADMISSION_BARRIER_TIMEOUT_MS)
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

it.each(['stalled', 'failed', 'stalled-with-refusal-write'] as const)(
  'refuses a %s admission barrier without late dispatch',
  async (barrier) => {
    const ctx = await context()
    const { store } = hostTestState()
    vi.spyOn(store, 'recordOperationOutcome').mockResolvedValue()
    const pending = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<void>()
    const refusing = Promise.withResolvers<void>()
    if (barrier === 'stalled-with-refusal-write') {
      vi.spyOn(ctx.journal, 'resolveDispatch').mockImplementationOnce(() => {
        refusing.resolve()
        return pending.promise.then(() => ctx.journal.cursor())
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    }
    ctx.flushStreamedEvents = () => {
      waiting.resolve()
      return barrier === 'failed' ? Promise.reject(new Error('disk unavailable')) : pending.promise
    }
    const beforeRun = vi.fn()
    const body = hostTestMessage('Continue the interrupted work')
    const operation = envelope('agentSession.send', { body })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = runSettledAgentSessionMutation({
      store,
      operationCallerKey: 'test',
      envelope: operation,
      context: ctx,
      plan: sendPlan({ envelope: operation, body, beforeRun })
    }).catch((error: unknown) => error)
    await waiting.promise
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_ADMISSION_BARRIER_TIMEOUT_MS)
    if (barrier === 'stalled-with-refusal-write') {
      await refusing.promise
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_ADMISSION_BARRIER_TIMEOUT_MS)
    }
    expect(await result).toBeInstanceOf(AgentSessionPreDispatchError)
    expect(beforeRun).not.toHaveBeenCalled()
    expect(hostTestState().dispatch).not.toHaveBeenCalled()
    expect(ctx.journal.submissions()[0]?.dispatchState).toBe(
      barrier === 'stalled-with-refusal-write' ? 'pending' : 'rejected'
    )
    pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(hostTestState().dispatch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }
)
