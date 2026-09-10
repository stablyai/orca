import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { RpcContext } from '../core'
import type { OrchestrationDb } from '../../orchestration/db'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { selectExactWorkerProviderSession } from '../../orchestration/worker-provider-session'
import { createOrchestrationRpcHarness } from './orchestration/rpc-test-harness'

describe('orchestration nested-agent settlement', () => {
  const harness = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let context: RpcContext

  afterEach(() => {
    harness.cleanup()
  })

  function setup() {
    ;({ db, runtime, ctx: context } = harness.setup())
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? 'tab_worker:leaf_worker' : harness.coordinatorPaneKey
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : `runtime_test:${handle}:1`
    )
    const task = db.createTask({ spec: 'Implement the parent assignment.' })
    const dependent = db.createTask({ spec: 'Continue after the parent.', deps: [task.id] })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      'tab_worker:leaf_worker',
      undefined,
      'runtime_test:term_worker:1'
    )
    const capability = db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime_test:term_worker:1'
    })
    context = { runtime, orchestrationCapability: capability }
    return { task, dependent, dispatch }
  }

  function providerStatus(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
    return {
      paneKey: 'tab_worker:leaf_worker',
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt: Date.now(),
      state: 'working',
      prompt: '',
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'lead-session' },
      actorAttestation: {
        authorityId: 'agent-hook-main:test',
        incarnation: 1,
        revision: 1,
        observedAt: Date.now(),
        provider: 'codex',
        role: 'lead',
        eventName: 'PreToolUse',
        providerSessionId: 'lead-session',
        toolUseId: 'tool-lead'
      },
      ...overrides
    }
  }

  function observeProvider(overrides: Partial<AgentStatusIpcPayload> = {}): void {
    const session = selectExactWorkerProviderSession({
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime_test:term_worker:1',
      connectionId: null,
      launchToken: undefined,
      observedAfter: 0,
      statuses: [providerStatus(overrides)]
    })
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(session)
  }

  async function reportDone(taskId: string, dispatchId: string) {
    return harness.call(
      'orchestration.send',
      {
        from: 'term_worker',
        subject: 'Parent complete',
        body: 'Implemented the parent assignment. Verified the result. Nothing remains.',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      },
      context
    )
  }

  function expectUnsettled(taskId: string, dependentId: string, dispatchId: string): void {
    expect(db.getTask(taskId)).toMatchObject({ status: 'dispatched', result: null })
    expect(db.getTask(dependentId)?.status).toBe('pending')
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'dispatched',
      capability_revoked_at: null
    })
  }

  it('rejects a recognized provider child without settling any parent lifecycle state', async () => {
    const { task, dependent, dispatch } = setup()
    observeProvider({
      actorAttestation: {
        authorityId: 'agent-hook-main:test',
        incarnation: 1,
        revision: 2,
        observedAt: Date.now(),
        provider: 'codex',
        role: 'child',
        eventName: 'PreToolUse',
        providerSessionId: 'lead-session',
        providerActorId: 'child-reviewer',
        toolUseId: 'tool-child'
      }
    })

    const result = (await reportDone(task.id, dispatch.id)) as {
      lifecycle: { action: string; code: string }
      message: { type: string }
    }

    expect(result.lifecycle).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee_session'
    })
    expect(result.message.type).toBe('status')
    expectUnsettled(task.id, dependent.id, dispatch.id)
  })

  it('fails closed to coordinator review when live provider lineage is unavailable', async () => {
    const { task, dependent, dispatch } = setup()
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)

    const result = (await reportDone(task.id, dispatch.id)) as {
      lifecycle: { action: string; code: string; reason: string }
    }

    expect(result.lifecycle).toMatchObject({
      action: 'rejected',
      code: 'sender_actor_unverifiable'
    })
    expect(result.lifecycle.reason).toContain('coordinator review')
    expectUnsettled(task.id, dependent.id, dispatch.id)
  })

  it('rejects actor evidence from a stale provider session', async () => {
    const { task, dependent, dispatch } = setup()
    observeProvider({
      actorAttestation: {
        authorityId: 'agent-hook-main:test',
        incarnation: 1,
        revision: 3,
        observedAt: Date.now(),
        provider: 'codex',
        role: 'lead',
        eventName: 'PreToolUse',
        providerSessionId: 'replaced-session'
      }
    })

    const result = (await reportDone(task.id, dispatch.id)) as {
      lifecycle: { action: string; code: string }
    }

    expect(result.lifecycle).toMatchObject({
      action: 'rejected',
      code: 'sender_actor_unverifiable'
    })
    expectUnsettled(task.id, dependent.id, dispatch.id)
  })

  it('blocks lead finalization until native children are settled or absent', async () => {
    const { task, dependent, dispatch } = setup()
    observeProvider({
      subagents: [
        {
          id: 'child-reviewer',
          agentType: 'reviewer',
          state: 'working',
          startedAt: Date.now() - 1_000
        }
      ]
    })

    const result = (await reportDone(task.id, dispatch.id)) as {
      lifecycle: { action: string; code: string }
    }

    expect(result.lifecycle).toMatchObject({ action: 'rejected', code: 'nested_agents_active' })
    expectUnsettled(task.id, dependent.id, dispatch.id)
  })

  it('settles an attested lead with no active native children', async () => {
    const { task, dependent, dispatch } = setup()
    observeProvider({ subagents: undefined })

    const result = (await reportDone(task.id, dispatch.id)) as {
      lifecycle: { action: string }
    }

    expect(result.lifecycle.action).toBe('completed')
    const completedTask = db.getTask(task.id)
    expect(completedTask?.status).toBe('completed')
    expect(JSON.parse(completedTask?.result ?? '')).toMatchObject({
      provenance: 'worker_report',
      outcome: 'succeeded',
      body: 'Implemented the parent assignment. Verified the result. Nothing remains.'
    })
    expect(db.getTask(dependent.id)?.status).toBe('ready')
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'completed',
      capability_revoked_at: expect.any(String)
    })

    const revoked = (await reportDone(task.id, dispatch.id)) as {
      lifecycle: { action: string; code: string }
    }
    expect(revoked.lifecycle).toMatchObject({
      action: 'rejected',
      code: 'dispatch_capability_invalid'
    })
  })

  it('settles a recognized OpenCode lead from its live busy-session attestation', async () => {
    const { task, dependent, dispatch } = setup()
    observeProvider({
      agentType: 'opencode',
      providerSession: { key: 'session_id', id: 'opencode-session' },
      actorAttestation: {
        authorityId: 'agent-hook-main:test',
        incarnation: 1,
        revision: 2,
        observedAt: Date.now(),
        provider: 'opencode',
        role: 'lead',
        eventName: 'SessionBusy',
        providerSessionId: 'opencode-session'
      }
    })

    const result = (await reportDone(task.id, dispatch.id)) as {
      lifecycle: { action: string }
    }

    expect(result.lifecycle.action).toBe('completed')
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getTask(dependent.id)?.status).toBe('ready')
  })
})
