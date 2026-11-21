import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { observeUnconfirmedWorkerStart } from './unconfirmed-worker-start'
import { observeWorker } from './worker-presence-report'

const SUBJECT = "Worker's brief may not have been submitted"

function unknownStart(stage: string, seenWorkingFirst = false) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'unconfirmed start',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: 'term_worker',
    paneKey: makePaneKey('tab-worker', '11111111-1111-4111-8111-111111111111'),
    processIncarnation: 'worker:1',
    worktreeId: 'repo::worktree',
    setupState: 'not_applicable',
    effects: []
  })
  const deps = { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() }
  if (seenWorkingFirst) {
    observeWorker(db, { kind: 'local', dispatch }, { presence: 'working' }, deps)
  }
  db.markWorkerStartUnknown(dispatch.id, stage, 'not seen')
  const alerts = () =>
    db
      .getUnreadRunMailbox(run.id, 100, ['escalation'])
      .filter((message) => message.subject === SUBJECT)
  return { db, dispatchId: dispatch.id, target: { kind: 'local' as const, dispatch }, deps, alerts }
}

describe('an unconfirmed worker start', () => {
  it('tells a chat worker’s coordinator to check the chat, not to press Enter', () => {
    const { db, dispatchId, deps, alerts } = unknownStart('turn_start_unobserved')

    observeUnconfirmedWorkerStart(db, dispatchId, { surface: 'chat' }, deps)

    expect(alerts()).toHaveLength(1)
    expect(alerts()[0]?.body).toContain(`\`orchestration worker-show --dispatch ${dispatchId}\``)
    expect(alerts()[0]?.body).not.toContain('terminal send')
  })

  it('stays quiet for a start that never handed its brief over', () => {
    const { db, dispatchId, deps, alerts } = unknownStart('agent_readiness')

    observeUnconfirmedWorkerStart(db, dispatchId, { surface: 'terminal' }, deps)

    expect(alerts()).toEqual([])
  })

  it('is not sent again once the worker was seen at rest after it, which proves it ran', () => {
    const { db, dispatchId, target, deps, alerts } = unknownStart('dispatch_input')
    observeUnconfirmedWorkerStart(db, dispatchId, { surface: 'terminal' }, deps)
    observeWorker(
      db,
      target,
      {
        presence: 'at-rest',
        fence: 'term_worker:1',
        legacyStopKey: 'rest',
        rest: { from: 'term_worker', reason: 'needs-input', lastOutput: undefined }
      },
      deps
    )

    observeUnconfirmedWorkerStart(db, dispatchId, { surface: 'terminal' }, deps)

    expect(alerts()).toHaveLength(1)
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
  })

  it('marks a worker seen working before the verdict ready instead of alerting', () => {
    const { db, dispatchId, deps, alerts } = unknownStart('dispatch_input', true)

    observeUnconfirmedWorkerStart(db, dispatchId, { surface: 'terminal' }, deps)

    expect(alerts()).toEqual([])
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
  })

  it('marks the start ready on a rest seen with no turn start before it', () => {
    const { db, dispatchId, target, deps } = unknownStart('turn_start_unobserved')

    observeWorker(
      db,
      target,
      {
        presence: 'at-rest',
        fence: 'term_worker:1',
        legacyStopKey: 'rest',
        rest: { from: 'term_worker', reason: 'needs-input', lastOutput: undefined }
      },
      deps
    )

    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(db.getTask(target.dispatch.task_id)?.status).toBe('dispatched')
  })
})
