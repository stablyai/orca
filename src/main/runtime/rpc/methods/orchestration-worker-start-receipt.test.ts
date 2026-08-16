import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { failFederatedAttachmentWithReceipt } from './orchestration-federation-start-receipt'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'

const setup = {
  requested: 'not_applicable' as const,
  effective: 'not_applicable' as const,
  source: 'existing_worktree' as const,
  hookFound: false,
  startupPolicy: 'start-immediately' as const,
  state: 'not_applicable' as const
}
const launch = {
  requested: { agent: 'codex' as const, model: null, effort: null },
  effective: { agent: 'codex' as const, model: null, effort: null }
}

describe('worker-start deadline receipts', () => {
  it('returns the watchdog-settled local worker instead of failing it again', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ spec: 'deadline during start' })
      const started = db.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        budget: {
          group: 'start-deadline',
          index: 1,
          maxDispatches: 1,
          maxRuntimeMs: 30_000,
          maxRequests: 10,
          requestCapEnforcement: 'prompt_only',
          maxReviewCycles: 0,
          leaf: true
        },
        deadlineAt: '2026-08-15T00:00:01.000Z'
      })
      db.reconcileWorkerWatchdogSentinel(started.dispatch.id, {
        dispatchId: started.dispatch.id,
        startedAt: '2026-08-15T00:00:00.000Z',
        deadlineAt: started.worker.deadline_at,
        finishedAt: '2026-08-15T00:00:02.000Z',
        exitCode: null,
        signal: 'SIGKILL',
        stop: 'kill'
      })

      expect(
        failWorkerStartWithReceipt({
          db,
          runId: task.run_id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          failedStage: 'agent_readiness',
          error: new Error('late readiness result'),
          setup,
          launch,
          bounded: { deadlineAt: started.worker.deadline_at, budget: {}, leafControl: {} }
        })
      ).toMatchObject({ state: 'stopped', stage: 'runtime_budget_exhausted' })
    } finally {
      db.close()
    }
  })

  it('preserves a remote stop_unknown receipt instead of downgrading it to start_unknown', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const attachment = db.createRemoteDispatchAttachment({
        dispatchId: 'ctx_remote_start_deadline',
        taskId: 'task_remote_start_deadline',
        homePeerFingerprint: 'home_peer',
        protocolVersion: 2,
        runtimeEpoch: 'worker_epoch',
        deadlineAt: '2026-08-15T00:00:01.000Z',
        maxRequests: 10,
        mutationReceipt: {
          callerFingerprint: 'home_peer',
          requestId: 'remote_start_deadline',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_start_deadline_payload'
        }
      })
      db.reconcileRemoteWorkerWatchdogSentinel(attachment.dispatch_id, {
        dispatchId: attachment.dispatch_id,
        startedAt: '2026-08-15T00:00:00.000Z',
        deadlineAt: attachment.deadline_at,
        finishedAt: '2026-08-15T00:00:02.000Z',
        exitCode: null,
        signal: null,
        stop: 'tree_kill_unknown'
      })

      expect(
        failFederatedAttachmentWithReceipt({
          db,
          dispatchId: attachment.dispatch_id,
          runtimeEpoch: 'worker_epoch',
          failedStage: 'agent_readiness',
          error: new Error('late readiness result'),
          setup,
          launch
        })
      ).toMatchObject({ state: 'stop_unknown', stage: 'deadline_sentinel_missing' })
    } finally {
      db.close()
    }
  })
})
