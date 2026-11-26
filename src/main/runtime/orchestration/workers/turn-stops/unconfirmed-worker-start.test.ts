import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { WORKER_AGENT_STARTING_STAGE } from '../../db/worker-dispatch/worker-awaiting-agent-stage'
import { readWorkerPresence } from '../../db/worker-presence/worker-presence-store'
import { observeUnconfirmedWorkerStart } from './unconfirmed-worker-start'

describe('a start whose agent was still starting when Orca restarted', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  it('is told to its coordinator by the restart pass', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    const dispatchId = started.dispatch.id
    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: 'term_worker',
      paneKey: 'tab_worker:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'worker:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    db.markWorkerStartUnknown(dispatchId, WORKER_AGENT_STARTING_STAGE, 'still starting')

    // The new process holds the earlier process's brief, so only this alert says the start is undecided.
    observeUnconfirmedWorkerStart(
      db,
      dispatchId,
      { surface: 'chat' },
      { getDb: () => db, isWaitingForMail: () => false, notify: () => {} }
    )

    expect(readWorkerPresence(db, dispatchId)).toMatchObject({
      presence: 'resting',
      fence: 'start-unconfirmed'
    })
  })
})
