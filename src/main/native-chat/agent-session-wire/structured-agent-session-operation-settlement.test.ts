import { afterEach, expect, it, vi } from 'vitest'
import {
  AgentSessionPreDispatchError,
  runSettledAgentSessionMutation
} from './structured-agent-session-operation-settlement'
import {
  adapter,
  attach,
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
import { runCommandReceiptMutation } from './structured-agent-session-command-receipt'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

async function context(): Promise<AgentSessionTurnContext> {
  await attach()
  return {
    logger: createStructuredAgentSessionLogger(),
    sessionId: SESSION,
    journal: await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      stateDirectory: hostTestState().root
    }),
    fence: 1,
    agents: NO_STRUCTURED_AGENTS,
    agent: 'codex',
    adapter: adapter(),
    persistOptions: async () => {},
    resolvedBy: 'test',
    publish: () => {},
    now: () => 0
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('rethrows a throw from a plan answered by its write, writing nothing and leaving the row pending', async () => {
  const ctx = await context()
  const { store } = hostTestState()
  const writes = vi.spyOn(store, 'recordOperationOutcome')
  const refusal = new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const result = await runCommandReceiptMutation({
    store,
    operationCallerKey: 'test',
    fingerprint: 'test-fingerprint',
    envelope: envelope('agentSession.send', {}),
    context: ctx,
    plan: {
      method: 'agentSession.send',
      fields: {},
      settlesWithWrite: true,
      run: async () => {
        throw refusal
      },
      replay: () => null
    }
  }).catch((error: unknown) => error)
  expect(result).toBe(refusal)
  expect(writes).not.toHaveBeenCalled()
  expect(hostTestState().dispatch).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  { plan: 'answered by its write', settlesWithWrite: true as const, failures: 0 },
  { plan: 'settled after its run', settlesWithWrite: undefined, failures: 2 }
])(
  'preserves a proven refusal of a plan $plan through $failures failed bookkeeping writes',
  async ({ settlesWithWrite, failures }) => {
    const ctx = await context()
    const { store, dispatch } = hostTestState()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const writes = vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async () => {
      throw new Error('private unbounded disk detail')
    })
    const refusal = {
      ok: false as const,
      refusal: { code: 'agent_session_operation_invalid' as const, message: 'Not sent.' }
    }
    const run = vi.fn(async () => refusal)
    const input = {
      store,
      operationCallerKey: 'test',
      envelope: envelope('agentSession.send', {}),
      context: ctx,
      plan: { method: 'agentSession.send', fields: {}, run, replay: () => null }
    }
    const result = settlesWithWrite
      ? await runCommandReceiptMutation({
          ...input,
          fingerprint: 'test-fingerprint',
          plan: { ...input.plan, settlesWithWrite }
        })
      : await runSettledAgentSessionMutation(input)
    expect(result).toEqual(refusal)
    expect(writes).toHaveBeenCalledTimes(failures)
    expect(run).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled()
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private unbounded disk detail')
  }
)

// A send's plan only accepts: it records the submission and never reaches the provider. Handing
// it over is the delivery loop's.
it('accepts without touching the provider', async () => {
  const ctx = await context()
  const { store } = hostTestState()
  vi.spyOn(store, 'recordOperationOutcome').mockResolvedValue()
  const beforeRun = vi.fn()
  const body = hostTestMessage('Continue the interrupted work')
  const operation = envelope('agentSession.send', { body })
  const result = await runCommandReceiptMutation({
    store,
    operationCallerKey: 'test',
    fingerprint: 'test-fingerprint',
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
})

it('refuses a superseded send at acceptance, recording and dispatching nothing', async () => {
  const ctx = await context()
  const { store } = hostTestState()
  const writes = vi.spyOn(store, 'recordOperationOutcome').mockResolvedValue()
  const beforeRun = vi.fn(() => {
    throw new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  })
  const body = hostTestMessage('Continue the interrupted work')
  const operation = envelope('agentSession.send', { body })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const result = await runCommandReceiptMutation({
    store,
    operationCallerKey: 'test',
    fingerprint: 'test-fingerprint',
    envelope: operation,
    context: ctx,
    plan: sendPlan({ envelope: operation, body, beforeRun })
  }).catch((error: unknown) => error)
  expect(result).toBeInstanceOf(AgentSessionPreDispatchError)
  expect(writes).not.toHaveBeenCalled()
  expect(ctx.journal.submissions()).toEqual([])
  expect(hostTestState().dispatch).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('returns the pre-acceptance refusal without recording a receipt', async () => {
  const ctx = await context()
  const { store } = hostTestState()
  const writes = vi.spyOn(store, 'recordOperationOutcome').mockResolvedValue()
  const body = hostTestMessage('message')
  const operation = envelope('agentSession.send', { body })
  const refusal = {
    code: 'agent_session_operation_invalid' as const,
    details: { reason: 'journalWriteFailed' as const },
    message: 'The message could not be saved.'
  }
  expect(
    await runCommandReceiptMutation({
      store,
      operationCallerKey: 'test',
      fingerprint: 'test-fingerprint',
      envelope: operation,
      context: ctx,
      plan: {
        ...sendPlan({ envelope: operation, body }),
        run: async () => ({ ok: false, refusal })
      }
    })
  ).toMatchObject({ ok: false, refusal })
  expect(writes).not.toHaveBeenCalled()
})
