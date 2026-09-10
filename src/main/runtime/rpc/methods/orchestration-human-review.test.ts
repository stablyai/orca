import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { RpcContext, RpcMethod } from '../core'
import { ALL_RPC_METHODS } from './index'
import { ORCHESTRATION_HUMAN_REVIEW_METHODS } from './orchestration-human-review'

const principalState = vi.hoisted(() => ({
  current: {
    actor_id: 'worker-1',
    kind: 'worker' as 'worker' | 'user',
    authenticated: true as const,
    session_id: 'session-1',
    workspace: {
      execution_host_id: 'local',
      workspace_key: 'folder:workspace-1',
      run_id: 'run-1'
    }
  }
}))

vi.mock('../maestro-principal', () => ({
  resolveMaestroPrincipal: async () => principalState.current
}))

function method(name: string): RpcMethod {
  const found = ORCHESTRATION_HUMAN_REVIEW_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing human-review method ${name}`)
  }
  return found
}

describe('Maestro human review RPC', () => {
  let database: OrchestrationDb
  let context: RpcContext
  let workspace: {
    repository_id: string
    execution_host_id: string
    workspace_key: string
    run_id: string
  }
  let taskId: string
  let dispatchId: string

  beforeEach(() => {
    database = new OrchestrationDb(':memory:')
    const run = database.createRun({
      objective: 'Review application',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    workspace = {
      repository_id: 'repo-1',
      execution_host_id: 'local',
      workspace_key: 'folder:workspace-1',
      run_id: run.id
    }
    taskId = database.createTask({ spec: 'Prepare application', runId: run.id }).id
    dispatchId = database.createDispatchContext({
      taskId,
      assigneeHandle: 'worker-1',
      creator: { kind: 'system' },
      maxDepth: 4
    }).id
    principalState.current = {
      actor_id: 'worker-1',
      kind: 'worker',
      authenticated: true,
      session_id: 'worker-session-1',
      workspace
    }
    context = { runtime: { getOrchestrationDb: () => database } } as RpcContext
  })

  afterEach(() => database.close())

  async function call(name: string, params: unknown) {
    const rpcMethod = method(name)
    return rpcMethod.handler(rpcMethod.params?.parse(params), context)
  }

  it('registers the durable review methods in the live RPC manifest', () => {
    expect(ALL_RPC_METHODS.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'maestro.humanReview.create',
        'maestro.humanReview.list',
        'maestro.humanReview.transition'
      ])
    )
  })

  it('lets a worker stage only its exact Task and Dispatch', async () => {
    const create = {
      request_id: 'stage-request-1',
      workspace,
      coordinator_generation: 1,
      review_id: 'review-1',
      task_id: taskId,
      dispatch_id: dispatchId,
      title: 'Application review',
      summary: 'Review before submission.',
      state: 'needs_input',
      references: {
        fields: [],
        documents: [{ document_ref: 'document-1', revision: 'revision-1', title: 'Application' }],
        browser: null
      },
      decisions: [{ decision_id: 'email', prompt: 'Confirm the email.' }]
    }
    await expect(call('maestro.humanReview.create', create)).resolves.toMatchObject({
      state: 'needs_input',
      staged_receipt: { actor: { kind: 'worker' } }
    })
    await expect(
      call('maestro.humanReview.create', {
        ...create,
        request_id: 'stage-request-2',
        review_id: 'review-2',
        dispatch_id: 'dispatch-other'
      })
    ).rejects.toThrow('exact active Task and Dispatch')
  })

  it('requires an authenticated human for approval and submission receipts', async () => {
    await call('maestro.humanReview.create', {
      request_id: 'stage-request-1',
      workspace,
      coordinator_generation: 1,
      review_id: 'review-1',
      task_id: taskId,
      dispatch_id: dispatchId,
      title: 'Application review',
      summary: 'Review before submission.',
      state: 'needs_input',
      references: {
        fields: [],
        documents: [{ document_ref: 'document-1', revision: 'revision-1', title: 'Application' }],
        browser: null
      },
      decisions: [{ decision_id: 'email', prompt: 'Confirm the email.' }]
    })
    const approval = {
      request_id: 'approval-request-1',
      workspace,
      review_id: 'review-1',
      action: 'approve',
      receipt_id: 'approval-1',
      decision_resolutions: [{ decision_id: 'email', resolution: 'Confirmed.' }],
      expires_at: '2099-01-01T00:00:00.000Z'
    }
    await expect(call('maestro.humanReview.transition', approval)).rejects.toThrow(
      'Only an authenticated human'
    )

    principalState.current = {
      ...principalState.current,
      actor_id: 'human-1',
      kind: 'user',
      session_id: 'human-session-1'
    }
    await expect(call('maestro.humanReview.transition', approval)).resolves.toMatchObject({
      state: 'approved_for_submit',
      approval_receipt: { actor: { kind: 'user' } }
    })
  })
})
