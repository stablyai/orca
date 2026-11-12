// Pin #11745 through state as well as replies: refused calls must not mutate graphs or fence legitimate coordinators.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrchestrationCompatibilityEvidence } from '../../../../../shared/orchestration/orchestration-compatibility-evidence'
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
  CURRENT_WORKER_HANDLE,
  CURRENT_WORKER_PANE,
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

function unattested(proof: OrchestrationCompatibilityEvidence): OrchestrationCompatibilityEvidence {
  return { ...proof, launchToken: '' }
}

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

function bindRunA(harness: LegacyCompatibilityDispatcherHarness): string {
  return harness.db.createRun({
    objective: 'run A work',
    coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
    coordinatorPaneKey: CURRENT_COORDINATOR_PANE
  }).id
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

describe('#11745 H1 — gate methods authorize the caller Run', () => {
  it('G5 leaves a foreign gate pending and its task blocked', async () => {
    const harness = createHarness()
    bindRunA(harness)
    const gate = harness.db.createGate({ taskId: harness.taskId, question: 'Proceed?' })
    const before = adoptedGraph(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateResolve',
        { id: gate.id, resolution: 'yes', from: CURRENT_COORDINATOR_HANDLE },
        unattested(currentEvidence('coordinator')),
        'v-g5'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { message: `Gate not found: ${gate.id}` } })
    expect(harness.db.getGate(gate.id)).toMatchObject({ status: 'pending', resolution: null })
    expect(adoptedGraph(harness)).toEqual(before)
    expect(before.task).toBe('blocked')
  })

  it('POSITIVE: a legitimately bound coordinator still gates its own Run end to end', async () => {
    const harness = createHarness()
    const runA = bindRunA(harness)
    const ownTask = harness.db.createTask({ spec: 'own work', runId: runA })

    const created = (await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        {
          task: ownTask.id,
          question: 'Ship?',
          options: JSON.stringify(['yes', 'no']),
          from: CURRENT_COORDINATOR_HANDLE
        },
        currentEvidence('coordinator'),
        'v-positive-create'
      )
    )) as { ok: true; result: { gate: { id: string; run_id: string } } }

    expect(created).toMatchObject({ ok: true, result: { gate: { run_id: runA } } })
    expect(harness.db.getTask(ownTask.id)?.status).toBe('blocked')

    const listed = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateList',
        { from: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('coordinator'),
        'v-positive-list'
      )
    )
    expect(listed).toMatchObject({ ok: true, result: { runId: runA, count: 1 } })

    const resolved = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateResolve',
        { id: created.result.gate.id, resolution: 'yes', from: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('coordinator'),
        'v-positive-resolve'
      )
    )
    expect(resolved).toMatchObject({ ok: true, result: { gate: { status: 'resolved' } } })
    expect(harness.db.getTask(ownTask.id)?.status).toBe('ready')
  })
})

describe('#11745 H1 — is --from an authenticated identity?', () => {
  // Attestation cannot authorize someone else's declared handle; shared resolveRunScope must fence both gate and older task paths.
  it('refuses an attested caller naming ANOTHER coordinator handle in --from', async () => {
    const harness = createHarness()
    const runA = bindRunA(harness)
    const victimTask = harness.db.createTask({ spec: 'victim work', runId: runA })

    // The attested worker has no Run binding and cannot speak for the declared coordinator.
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: victimTask.id, question: 'spoofed?', from: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('worker'),
        'v-spoof-gate-create'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(harness.db.getTask(victimTask.id)?.status).not.toBe('blocked')
    expect(harness.db.listGates({ taskId: victimTask.id })).toHaveLength(0)
  })

  it('refuses an attested caller rebinding another terminal with runUse', async () => {
    const harness = createHarness()
    const runA = bindRunA(harness)
    const workerRun = harness.db.createRun({
      objective: 'worker Run',
      coordinatorHandle: CURRENT_WORKER_HANDLE,
      coordinatorPaneKey: CURRENT_WORKER_PANE
    })
    const beforeA = harness.db.getRun(runA)
    const beforeWorker = harness.db.getRun(workerRun.id)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.runUse',
        { id: workerRun.id, from: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('worker'),
        'v-spoof-run-use'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(harness.db.getRun(runA)).toEqual(beforeA)
    expect(harness.db.getRun(workerRun.id)).toEqual(beforeWorker)
  })
})

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

  it('still fences the bind while legacy work IS live, with a usable recovery command', () => {
    const { db, adoptedRunId, recoveryMessageId } = createAdoptedDb({ settleWork: false })

    expect(() =>
      db.bindRun({
        runId: adoptedRunId,
        coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
        coordinatorPaneKey: CURRENT_COORDINATOR_PANE
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'consumer_fenced',
        data: {
          effectsApplied: false,
          recoveryCommand: `orca orchestration run-use --id ${adoptedRunId} --takeover-legacy`
        }
      })
    )
    expect(db.getRun(adoptedRunId)?.coordinator_handle).toBeNull()
    expect(db.getMessageById(recoveryMessageId)?.run_id).toBe(adoptedRunId)
  })
})

describe('#11745 L6 — indexed getCurrentRunForPane keeps pane equivalence', () => {
  function paneDb(): OrchestrationDb {
    const dir = mkdtempSync(join(tmpdir(), 'orca-11745-l6-'))
    tempDirs.push(dir)
    const db = new OrchestrationDb(join(dir, 'orchestration.db'))
    databases.push(db)
    return db
  }

  function leaf(index: number): string {
    const hex = index.toString(16).padStart(12, '0')
    return `${hex.slice(0, 8)}-0000-4000-8000-${hex}`
  }

  it('keeps unparseable pane keys on exact-match semantics', () => {
    const db = paneDb()
    const noColon = db.createRun({
      objective: 'no colon',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: 'nocolonpanekey'
    })
    const twoColons = db.createRun({
      objective: 'two colons',
      coordinatorHandle: 'term_b',
      coordinatorPaneKey: `win:tab:${leaf(3)}`
    })
    const emptyLeaf = db.createRun({
      objective: 'empty leaf',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: 'tab_empty:'
    })

    expect(db.getCurrentRunForPane('nocolonpanekey')?.id).toBe(noColon.id)
    expect(db.getCurrentRunForPane(`win:tab:${leaf(3)}`)?.id).toBe(twoColons.id)
    expect(db.getCurrentRunForPane('tab_empty:')?.id).toBe(emptyLeaf.id)

    // Unparseable first segments must match too: suffix index narrows candidates; isEquivalentPaneKey decides.
    expect(db.getCurrentRunForPane(`other:tab:${leaf(3)}`)).toBeUndefined()
    expect(db.getCurrentRunForPane('other_empty:')).toBeUndefined()
    // A shared suffix cannot equate parseable and unparseable keys.
    expect(db.getCurrentRunForPane(`tab:${leaf(3)}`)).toBeUndefined()
  })

  it('unbinds the equivalent pane when a reminted key run-uses a new Run', () => {
    const db = paneDb()
    const first = db.createRun({
      objective: 'first',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: `tab_one:${leaf(4)}`
    })
    const second = db.createRun({
      objective: 'second',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: `tab_two:${leaf(4)}`
    })
    db.bindRun({
      runId: second.id,
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: `tab_two:${leaf(4)}`
    })

    expect(db.getRun(first.id)?.coordinator_pane_key).toBeNull()
    expect(db.getCurrentRunForPane(`tab_three:${leaf(4)}`)?.id).toBe(second.id)
  })
})
