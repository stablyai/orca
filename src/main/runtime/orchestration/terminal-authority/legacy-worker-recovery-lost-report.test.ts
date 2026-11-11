import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import '../db/contract-constants'
import '../db/messages/mailbox-routing-page'
import '../db/dispatch-row-writer'
import '../db/attempt-outcome-projection'
import { planLegacyWorkerTerminalRecovery } from './release/orchestration-legacy-worker-terminal-recovery'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'

describe('a worker whose terminal is gone after a restart', () => {
  let directory: string
  let db: OrchestrationDb
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-recovery-lost-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function runningWorker() {
    const run = db.createRun({
      objective: 'merge after CI',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey:
        '99999999-9999-4999-8999-999999999999:88888888-8888-4888-8888-888888888888'
    })
    const task = db.createTask({ runId: run.id, spec: 'watch CI and merge' })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_worker',
      paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
      processIncarnation: 'pty-1:33333333-3333-4333-8333-333333333333',
      worktreeId: 'repo::/workspace',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return { runId: run.id, dispatchId: dispatch.id }
  }

  function recover(notify = vi.fn()) {
    const persistence = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
      () => null,
      () => db,
      () => null
    )
    const plan = planLegacyWorkerTerminalRecovery(db.listLegacyWorkerTerminalRecoveryRows())
    const lostWorkers = {
      reportDeps: { getDb: () => db, isWaitingForMail: () => false, notify },
      lastOutput: async () => 'gh pr checks 596 --watch'
    }
    for (const candidate of plan.candidates) {
      persistence.reconcileMissing(candidate, lostWorkers)
    }
    return { persistence, plan, notify, lostWorkers }
  }

  it('tells the coordinator once that it is lost, with its last output', async () => {
    const { runId, dispatchId } = runningWorker()
    const { persistence, plan, notify, lostWorkers } = recover()
    // A second pass over the same candidate must not repeat the alert.
    persistence.reconcileMissing(plan.candidates[0]!, lostWorkers)
    await vi.waitFor(() => expect(notify).toHaveBeenCalled())

    expect(db.getDispatchContextById(dispatchId)?.status).toBe('failed')
    const mail = db.getUnreadMessages(`run:${runId}`, ['escalation'])
    expect(mail.map((message) => message.subject)).toEqual(['Worker lost without reporting'])
    expect(mail[0]?.body).toContain('is gone (its terminal was gone when Orca restarted)')
    expect(mail[0]?.body).toContain('gh pr checks 596 --watch')
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
