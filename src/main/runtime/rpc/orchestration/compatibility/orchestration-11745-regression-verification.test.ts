// Pin #11745 through state as well as replies: refused calls must not mutate graphs or fence legitimate coordinators.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import SyncDatabase from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import '../../../orchestration/db/contract-constants'
import '../../../orchestration/db/messages/mailbox-routing-page'
import '../../../orchestration/db/dispatch-row-writer'
import '../../../orchestration/db/attempt-outcome-projection'
import {
  cleanupLegacyCompatibilityDispatcherHarnesses,
  COORDINATOR_HANDLE,
  counts,
  createHarness,
  currentEvidence,
  CURRENT_COORDINATOR_HANDLE,
  CURRENT_COORDINATOR_PANE,
  evidence,
  request,
  type LegacyCompatibilityDispatcherHarness
} from './testing/orchestration-legacy-compatibility-dispatcher-test-fixture'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'

const tempDirs: string[] = []
const databases: OrchestrationDb[] = []

afterEach(() => {
  cleanupLegacyCompatibilityDispatcherHarnesses()
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Every observable the adopted Run's recovered graph exposes; a refusal must leave all of it equal. */
function adoptedGraph(harness: LegacyCompatibilityDispatcherHarness) {
  return {
    task: harness.db.getTask(harness.taskId)?.status,
    dispatch: harness.db.getDispatchContextById(harness.dispatchId)?.status,
    gates: harness.db.listGates({ taskId: harness.taskId }).length,
    tasksInRun: harness.db.listTasks({ runId: harness.adoptedRunId }).length,
    run: harness.db.getRun(harness.adoptedRunId)?.coordinator_handle ?? null,
    tables: counts(harness.db)
  }
}

async function legacyClaimsAdoptedRun(
  harness: LegacyCompatibilityDispatcherHarness,
  id: string
): Promise<void> {
  const response = await harness.dispatcher.dispatch(
    request(
      'orchestration.runUse',
      { id: harness.adoptedRunId, from: COORDINATOR_HANDLE },
      evidence('coordinator'),
      `${id}-legacy-claim`
    )
  )
  expect(response).toMatchObject({ ok: true })
}

async function currentCoordinatorTakesOver(
  harness: LegacyCompatibilityDispatcherHarness,
  id: string
): Promise<void> {
  const response = await harness.dispatcher.dispatch(
    request(
      'orchestration.runUse',
      { id: harness.adoptedRunId, from: CURRENT_COORDINATOR_HANDLE, takeoverLegacy: true },
      currentEvidence('coordinator'),
      `${id}-takeover`
    )
  )
  expect(response).toMatchObject({ ok: true })
}

describe('#11745 H3 — adopted Run claimed by the legacy coordinator', () => {
  it('still fences the genuinely stale legacy coordinator with legacy_read_only and zero effects', async () => {
    const harness = createHarness()
    await legacyClaimsAdoptedRun(harness, 'v-h3b')
    await currentCoordinatorTakesOver(harness, 'v-h3b')
    const before = adoptedGraph(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'stale assignment',
          run: harness.adoptedRunId,
          callerTerminalHandle: COORDINATOR_HANDLE
        },
        evidence('coordinator'),
        'v-h3b-stale'
      )
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'legacy_read_only', data: { effectsApplied: false } }
    })
    expect(adoptedGraph(harness)).toEqual(before)
  })
})

/** Builds a pre-cutover graph at schema 18 and reopens it so adoption runs. */
function createAdoptedDb(options: { settleWork: boolean }): {
  db: OrchestrationDb
  adoptedRunId: string
  recoveryMessageId: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'orca-11745-m5-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'orchestration.db')

  const before = new OrchestrationDb(dbPath)
  const task = before.createTask({
    runId: 'run_legacy_local',
    spec: 'legacy assignment',
    createdByTerminalHandle: 'term_old'
  })
  createRootDispatch(
    before,
    task.id,
    'term_old_worker',
    'tab_old:33333333-3333-4333-8333-333333333333'
  )
  const recovery = before.insertMessage({
    runId: 'run_legacy_local',
    from: 'term_old_worker',
    to: 'term_old',
    subject: 'recovered worker outcome',
    type: 'worker_done'
  })
  before.close()

  const raw = new SyncDatabase(dbPath)
  if (options.settleWork) {
    raw.exec("UPDATE dispatch_contexts SET status = 'completed'")
  }
  raw.exec(`
    DROP INDEX IF EXISTS idx_messages_delivery_contract;
    DROP TABLE legacy_mail_receipts;
    DROP TABLE legacy_operation_receipts;
    DROP TABLE legacy_compatibility_principals;
    DROP TABLE legacy_adoptions;
  `)
  raw.pragma('user_version = 18')
  raw.close()

  const db = new OrchestrationDb(dbPath)
  databases.push(db)
  return {
    db,
    adoptedRunId: db.getLegacyAdoption()?.adopted_run_id as string,
    recoveryMessageId: recovery.id
  }
}

describe('#11745 M5 — binding an unclaimed adopted Run', () => {
  it('binds without --takeover-legacy when no legacy work is live, and keeps legacy mail promoted', () => {
    const { db, adoptedRunId, recoveryMessageId } = createAdoptedDb({ settleWork: true })
    expect(db.getMessageById(recoveryMessageId)?.run_id).toBe(adoptedRunId)

    const run = db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })

    expect(run?.id).toBe(adoptedRunId)
    expect(db.getRun(adoptedRunId)).toMatchObject({
      coordinator_handle: CURRENT_COORDINATOR_HANDLE
    })
    // The recovered mail must still belong to the adopted Run, not be orphaned by the bind.
    expect(db.getMessageById(recoveryMessageId)?.run_id).toBe(adoptedRunId)
    expect(db.getCurrentRunForPane(CURRENT_COORDINATOR_PANE)?.id).toBe(adoptedRunId)
  })
})
