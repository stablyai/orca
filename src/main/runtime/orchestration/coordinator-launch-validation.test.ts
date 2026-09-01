import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import {
  Coordinator,
  type CoordinatorRuntime,
  type DispatchAgentIdentity,
  type DispatchAgentLaunchValidation
} from './coordinator'
import type { PersistedAgentLaunchFailure } from '../../../shared/agent-launch-contract'

// (b)-lite orchestration seam (§U6): the coordinator resolve-only re-validates a
// dispatch's host-validated identity before injecting a worker prompt. Production
// dispatches carry a null identity (no source until U9), so validation is inert;
// these tests inject an identity + a validation outcome to prove the failure path
// fails the dispatch through the existing retry/circuit-break machinery WITHOUT
// creating a terminal or injecting a prompt (zero PTY on known failure).

type ValidationAwareRuntime = CoordinatorRuntime & {
  sentMessages: { handle: string; text: string }[]
  createdTerminals: string[]
  validateCalls: DispatchAgentIdentity[]
  terminals: { handle: string; worktreeId: string; connected: boolean; writable: boolean }[]
}

function createRuntime(validation: DispatchAgentLaunchValidation | null): ValidationAwareRuntime {
  const mock: ValidationAwareRuntime = {
    sentMessages: [],
    createdTerminals: [],
    validateCalls: [],
    terminals: [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }],
    async sendTerminalAgentPrompt(handle: string, text: string) {
      mock.sentMessages.push({ handle, text })
      return { handle, accepted: true }
    },
    async listTerminals() {
      return { terminals: mock.terminals }
    },
    async createTerminal(_worktree?: string, opts?: { title?: string }) {
      const handle = `term_worker_${mock.createdTerminals.length}`
      mock.createdTerminals.push(handle)
      mock.terminals.push({ handle, worktreeId: 'wt1', connected: true, writable: true })
      return { handle, worktreeId: 'wt1', title: opts?.title ?? '' }
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'exit' }
    },
    async probeWorktreeDrift() {
      return null
    },
    ...(validation
      ? {
          async validateDispatchAgentLaunch(identity: DispatchAgentIdentity) {
            mock.validateCalls.push(identity)
            return validation
          }
        }
      : {})
  }
  return mock
}

function insertWorkerDone(db: OrchestrationDb, taskId: string, from: string): void {
  const dispatch = db.getDispatchContext(taskId)
  db.insertMessage({
    from,
    to: 'coord',
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({ taskId, dispatchId: dispatch?.id, outcome: 'succeeded' })
  })
}

const failure: PersistedAgentLaunchFailure = {
  code: 'base_agent_disabled',
  version: 1,
  failureId: 'fail-orchestration-1',
  intent: 'orchestration',
  occurredAt: 1_700_000_000_000
}

describe('coordinator dispatch launch validation', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('never validates when no identity source is configured (production no-op)', async () => {
    db = new OrchestrationDb(':memory:')
    // Runtime exposes the validation callback, but no resolveDispatchIdentity is
    // configured, so every dispatch identity is null and validation is skipped.
    const runtime = createRuntime({ ok: false, error: 'unused', launchFailure: failure })
    const task = db.createTask({ spec: 'ship it' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20
    })
    const runPromise = coordinator.run()
    await new Promise((r) => setTimeout(r, 60))
    insertWorkerDone(db, task.id, 'term_a')
    const result = await runPromise

    expect(runtime.validateCalls).toHaveLength(0)
    expect(runtime.sentMessages.length).toBeGreaterThan(0)
    expect(result.status).toBe('completed')
    expect(db.getDispatchContext(task.id)?.requested_agent).toBeNull()
  })

  it('fails a non-null identity dispatch through failDispatch with zero PTY', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createRuntime({ ok: false, error: 'agent disabled', launchFailure: failure })
    const task = db.createTask({ spec: 'ship it' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 10,
      resolveDispatchIdentity: () => ({ requestedAgent: 'ghost-agent', baseAgent: 'claude' })
    })
    // The dispatch keeps failing validation until the circuit breaker trips, at
    // which point the task is 'failed' and the run converges without any prompt.
    const result = await coordinator.run()

    expect(result.status).toBe('failed')
    // Zero PTY: no worker prompt injected and no worker terminal created — the
    // pre-provided idle terminal is reused across every failing retry.
    expect(runtime.sentMessages).toHaveLength(0)
    expect(runtime.createdTerminals).toHaveLength(0)
    expect(runtime.validateCalls.length).toBeGreaterThan(0)

    const dispatch = db.getDispatchContext(task.id)
    expect(dispatch?.status).toBe('circuit_broken')
    expect(dispatch?.failure_count).toBe(3)
    expect(dispatch?.requested_agent).toBe('ghost-agent')
    expect(JSON.parse(dispatch?.agent_launch_failure ?? '{}').code).toBe('base_agent_disabled')
    expect(db.getTask(task.id)?.status).toBe('failed')
  })

  it('dispatches normally when a non-null identity validates', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createRuntime({ ok: true })
    const task = db.createTask({ spec: 'ship it' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      resolveDispatchIdentity: () => ({ requestedAgent: 'my-claude', baseAgent: 'claude' })
    })
    const runPromise = coordinator.run()
    await new Promise((r) => setTimeout(r, 60))
    insertWorkerDone(db, task.id, 'term_a')
    const result = await runPromise

    expect(runtime.validateCalls).toEqual([{ requestedAgent: 'my-claude', baseAgent: 'claude' }])
    expect(runtime.sentMessages.length).toBeGreaterThan(0)
    expect(result.status).toBe('completed')
    expect(db.getDispatchContext(task.id)?.requested_agent).toBe('my-claude')
  })

  it('passes the dispatch target handle to the identity resolver (W-T1 Option B)', async () => {
    // The resolver reads the attribution of the terminal that actually receives
    // the work, so the coordinator must hand it the targetHandle, not just the
    // task. The pre-provided idle terminal 'term_a' is the dispatch target.
    db = new OrchestrationDb(':memory:')
    const runtime = createRuntime({ ok: true })
    const task = db.createTask({ spec: 'ship it' })
    const resolverArgs: { taskId: string; targetHandle: string }[] = []

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 20,
      resolveDispatchIdentity: (t, targetHandle) => {
        resolverArgs.push({ taskId: t.id, targetHandle })
        return { requestedAgent: 'my-claude', baseAgent: 'claude' }
      }
    })
    const runPromise = coordinator.run()
    await new Promise((r) => setTimeout(r, 60))
    insertWorkerDone(db, task.id, 'term_a')
    await runPromise

    expect(resolverArgs).toEqual([{ taskId: task.id, targetHandle: 'term_a' }])
  })
})
