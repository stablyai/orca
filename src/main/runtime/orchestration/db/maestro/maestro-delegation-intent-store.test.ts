import { describe, expect, it } from 'vitest'
import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import type { MaestroDelegationRequest } from '../../../../../shared/maestro-delegation'
import { OrchestrationDb } from '../orchestration-db'
import {
  getMaestroDelegation,
  requestMaestroDelegation,
  settleMaestroDelegation,
  takeMaestroDelegation
} from './maestro-delegation-intent-store'

const workspace = {
  repository_id: 'repo-1',
  execution_host_id: 'local',
  workspace_key: 'folder:folder-1',
  run_id: 'run-1'
}

function request(intentId: string, runId: string): MaestroDelegationRequest {
  return {
    schema_version: 1,
    protocol: 'maestro-delegation/v1',
    intent_id: intentId,
    workspace: { ...workspace, run_id: runId },
    source: { kind: 'task', task_id: 'task-1' },
    parent_task_id: 'task-1',
    parent_attempt_id: 'attempt-1',
    purpose: 'Run bounded work',
    role: 'implementation',
    requested: { lane: 'balanced', agent: null, model: null, effort: 'medium' },
    placement_request: { kind: 'current-workspace' },
    context_refs: [],
    paths: ['src/shared/maestro-delegation.ts'],
    check: 'pnpm test'
  }
}

function principal(
  kind: 'coordinator' | 'user' | 'worker',
  generation: number,
  runId: string
): MaestroPrincipal {
  return {
    actor_id: `${kind}-1`,
    kind,
    authenticated: true,
    session_id: `${kind}-session`,
    ...(kind === 'coordinator' || kind === 'worker' ? { generation } : {}),
    workspace: {
      execution_host_id: workspace.execution_host_id,
      workspace_key: workspace.workspace_key,
      run_id: runId
    }
  }
}

const resolved = {
  agent: null,
  model: null,
  effort: null,
  permission_mode: 'manual' as const,
  placement: {
    kind: 'current-workspace' as const,
    execution_host_id: 'local',
    workspace_key: 'folder:folder-1'
  }
}

describe('Maestro delegation intent store', () => {
  it('claims and settles exactly once, then replays the same result', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Delegation',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const coordinator = principal('coordinator', run.consumer_generation, run.id)
    const created = requestMaestroDelegation.call(
      db,
      request('intent-1', run.id),
      principal('user', run.consumer_generation, run.id),
      resolved
    )
    expect(created.state).toBe('pending')
    const claimed = takeMaestroDelegation.call(db, 'intent-1', coordinator)
    expect(claimed?.state).toBe('claimed')
    expect(
      takeMaestroDelegation.call(db, 'intent-1', { ...coordinator, session_id: 'other-session' })
    ).toBeUndefined()
    expect(takeMaestroDelegation.call(db, 'intent-1', coordinator)).toEqual(claimed)
    const receipt = {
      outcome: 'succeeded',
      worker: { dispatch_id: 'dispatch-1', terminal_id: 'terminal-1', tracked: true },
      detail: null
    }
    const settled = settleMaestroDelegation.call(db, 'intent-1', coordinator, receipt)
    expect(settled).toMatchObject({ state: 'succeeded', spawned_by: null })
    expect(
      settleMaestroDelegation.call(
        db,
        'intent-1',
        { ...coordinator, session_id: 'other-session' },
        receipt
      )
    ).toBeUndefined()
    expect(settleMaestroDelegation.call(db, 'intent-1', coordinator, receipt)).toEqual(settled)
    db.close()
  })

  it('fences stale coordinators and adds spawned_by for worker-created intents', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Delegation',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const worker = principal('worker', run.consumer_generation, run.id)
    const coordinator = principal('coordinator', run.consumer_generation, run.id)
    requestMaestroDelegation.call(db, request('intent-2', run.id), worker, resolved)
    expect(
      takeMaestroDelegation.call(
        db,
        'intent-2',
        principal('coordinator', run.consumer_generation + 1, run.id)
      )
    ).toBeUndefined()
    expect(takeMaestroDelegation.call(db, 'intent-2', coordinator)).toBeTruthy()
    expect(
      settleMaestroDelegation.call(db, 'intent-2', coordinator, {
        outcome: 'failed',
        detail: 'No launch'
      })
    ).toMatchObject({ state: 'failed', spawned_by: null })
    requestMaestroDelegation.call(db, request('intent-3', run.id), worker, resolved)
    takeMaestroDelegation.call(db, 'intent-3', coordinator)
    expect(
      settleMaestroDelegation.call(db, 'intent-3', coordinator, {
        outcome: 'succeeded',
        worker: { dispatch_id: 'dispatch-3', terminal_id: 'terminal-3', tracked: true },
        detail: null
      })
    ).toMatchObject({ state: 'succeeded', spawned_by: 'worker-1' })
    expect(() =>
      settleMaestroDelegation.call(db, 'intent-3', coordinator, {
        outcome: 'succeeded',
        worker: { dispatch_id: 'loose', terminal_id: 'loose', tracked: false },
        detail: null
      })
    ).toThrow()
    db.close()
  })

  it('binds requester reads and replays to actor kind and session', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Delegation',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const requester = principal('user', run.consumer_generation, run.id)
    const created = requestMaestroDelegation.call(
      db,
      request('intent-session', run.id),
      requester,
      resolved
    )
    expect(
      getMaestroDelegation.call(db, created.intent_id, {
        ...requester,
        session_id: 'other-session'
      })
    ).toBeUndefined()
    expect(() =>
      requestMaestroDelegation.call(
        db,
        request('intent-session', run.id),
        { ...requester, session_id: 'other-session' },
        resolved
      )
    ).toThrow(/reused/)
    db.close()
  })
})
