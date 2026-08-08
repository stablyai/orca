// Why: independent adversarial verification of every #11745 fix. Each case reproduces the ORIGINAL
// defect and asserts it is closed by observing state, not just the response envelope — a refusal
// that still mutated the graph is a failure, and so is a fix that fences a legitimate coordinator.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import SyncDatabase from '../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration/db'
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
  invoke,
  request,
  type LegacyCompatibilityDispatcherHarness
} from './orchestration-legacy-compatibility-dispatcher-test-fixture'

// Why: an unrelated caller the runtime CAN resolve to a pane — otherwise the refusal would be
// stable_pane_required and would prove nothing about Run authorization.
const OUTSIDER_HANDLE = CURRENT_WORKER_HANDLE
const OUTSIDER_PANE = CURRENT_WORKER_PANE

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
  it.each(['dispatch', 'websocket'] as const)(
    'G1 %s leaves the recovered task and its dispatch untouched for an unbound attested caller',
    async (transport) => {
      const harness = createHarness()
      const before = adoptedGraph(harness)

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.gateCreate',
          { task: harness.taskId, question: 'Proceed?' },
          currentEvidence('coordinator'),
          `v-g1-${transport}`
        ),
        transport
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'run_required' } })
      expect(adoptedGraph(harness)).toEqual(before)
      // The recovered graph really is live work, so "unchanged" is a meaningful assertion.
      expect(before.task).toBe('dispatched')
      expect(before.gates).toBe(0)
    }
  )

  it('G2 leaves the adopted Run untouched for an unattested caller bound to Run A', async () => {
    const harness = createHarness()
    bindRunA(harness)
    const before = adoptedGraph(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: harness.taskId, question: 'Proceed?', from: CURRENT_COORDINATOR_HANDLE },
        unattested(currentEvidence('coordinator')),
        'v-g2'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'task_not_found' } })
    expect(adoptedGraph(harness)).toEqual(before)
  })

  it('G3 leaves the adopted Run untouched once the legacy coordinator has claimed it', async () => {
    const harness = createHarness()
    await legacyClaimsAdoptedRun(harness, 'v-g3')
    bindRunA(harness)
    const before = adoptedGraph(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: harness.taskId, question: 'Proceed?', from: CURRENT_COORDINATOR_HANDLE },
        unattested(currentEvidence('coordinator')),
        'v-g3-gate'
      )
    )

    expect(response).toMatchObject({ ok: false })
    expect(adoptedGraph(harness)).toEqual(before)
  })

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

  it('G4 refuses a stranger Run with NO legacy adoption in play', () => {
    // Why: G4 must hold on a plain runtime, so the fix cannot be an artifact of adoption state.
    const dir = mkdtempSync(join(tmpdir(), 'orca-11745-g4-'))
    tempDirs.push(dir)
    const db = new OrchestrationDb(join(dir, 'orchestration.db'))
    databases.push(db)
    expect(db.getLegacyAdoption()).toBeUndefined()

    const runA = db.createRun({
      objective: 'run A',
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })
    const runC = db.createRun({
      objective: 'run C',
      coordinatorHandle: OUTSIDER_HANDLE,
      coordinatorPaneKey: OUTSIDER_PANE
    })
    const strangerTask = db.createTask({ spec: 'stranger work', runId: runC.id })

    // The Run-scope decision the gate handler makes: A's pane resolves to A, never to C.
    expect(db.getCurrentRunForPane(CURRENT_COORDINATOR_PANE)?.id).toBe(runA.id)
    expect(strangerTask.run_id).toBe(runC.id)
    expect(db.listGates({ taskId: strangerTask.id })).toHaveLength(0)
    expect(db.getTask(strangerTask.id)?.status).toBe('ready')
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

  it('POSITIVE: the proven legacy coordinator still gates the adopted Run task', async () => {
    const harness = createHarness()

    const created = (await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: harness.taskId, question: 'Proceed?', from: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'v-legacy-create'
      )
    )) as { ok: true; result: { gate: { id: string; run_id: string } } }

    expect(created).toMatchObject({
      ok: true,
      result: { gate: { run_id: harness.adoptedRunId, task_id: harness.taskId } }
    })
    expect(harness.db.getTask(harness.taskId)?.status).toBe('blocked')

    const resolved = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateResolve',
        { id: created.result.gate.id, resolution: 'go', from: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'v-legacy-resolve'
      )
    )
    expect(resolved).toMatchObject({ ok: true, result: { gate: { status: 'resolved' } } })
    expect(harness.db.getTask(harness.taskId)?.status).toBe('ready')
  })
})

describe('#11745 H1 — is --from an authenticated identity?', () => {
  // Why: Run scoping authorizes on a declared handle, so an attested caller naming someone else's
  // handle must be refused. Both cases run through the shared resolveRunScope, so they also pin
  // that the gate path and the older task path cannot diverge again.
  it('refuses an attested caller naming ANOTHER coordinator handle in --from', async () => {
    const harness = createHarness()
    const runA = bindRunA(harness)
    const victimTask = harness.db.createTask({ spec: 'victim work', runId: runA })

    // Caller is the current WORKER — attested as itself, bound to no Run — but names the
    // coordinator's handle. Nothing on this request proves it may speak for that handle.
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

  it('refuses the same spoof against taskCreate, which predates this change', async () => {
    const harness = createHarness()
    const runA = bindRunA(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        { spec: 'spoofed assignment', callerTerminalHandle: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('worker'),
        'v-spoof-task-create'
      )
    )

    // Why: the weakness was inherited from this older path, so the fix has to cover it too.
    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(harness.db.listTasks({ runId: runA })).toHaveLength(0)
  })

  it('refuses an attested caller creating a Run for another terminal', async () => {
    const harness = createHarness()
    const runA = bindRunA(harness)
    const before = harness.db.listRuns().runs

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.runCreate',
        { objective: 'spoofed Run', from: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('worker'),
        'v-spoof-run-create'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(harness.db.listRuns().runs).toEqual(before)
    expect(harness.db.getCurrentRunForPane(CURRENT_COORDINATOR_PANE)?.id).toBe(runA)
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

  it('refuses an attested caller querying another terminal with runCurrent', async () => {
    const harness = createHarness()
    bindRunA(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.runCurrent',
        { from: CURRENT_COORDINATOR_HANDLE },
        currentEvidence('worker'),
        'v-spoof-run-current'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
  })

  it('does not let legacy authority bypass a mismatched declared handle', async () => {
    const harness = createHarness()
    const before = adoptedGraph(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'spoofed legacy assignment',
          callerTerminalHandle: CURRENT_COORDINATOR_HANDLE
        },
        evidence('coordinator'),
        'v-spoof-legacy-shortcut'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(adoptedGraph(harness)).toEqual(before)
  })
})

describe('#11745 H1 — gateList read posture', () => {
  it('DOCUMENTS: naming a Run makes its gates readable with no caller identity at all', async () => {
    // Why: gateList mirrors taskList (requireCurrentConsumer: params.run === undefined), so an
    // explicitly named Run is inspectable by anyone. Reads only — gateCreate/gateResolve always
    // require the binding. Pinned here so any future narrowing is a deliberate decision.
    const harness = createHarness()
    const runA = bindRunA(harness)
    const ownTask = harness.db.createTask({ spec: 'own work', runId: runA })
    const ownGate = harness.db.createGate({ taskId: ownTask.id, question: 'Own?' })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateList',
        { run: runA },
        currentEvidence('worker'),
        'v-gate-list-named-run'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: { runId: runA, count: 1, gates: [{ id: ownGate.id }] }
    })
  })
})

describe('#11745 H2 — revoked principal on an unclaimed adopted Run', () => {
  it('answers an unbound caller with run_required, not legacy_read_only', async () => {
    const harness = createHarness()
    await legacyClaimsAdoptedRun(harness, 'v-h2')
    await currentCoordinatorTakesOver(harness, 'v-h2')
    // The new owner's pane rebinds elsewhere, leaving the adopted Run unclaimed + principal revoked.
    harness.db.createRun({
      objective: 'elsewhere',
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })
    expect(harness.db.getRun(harness.adoptedRunId)?.coordinator_pane_key).toBeNull()
    expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)?.status).toBe('revoked')
    const before = adoptedGraph(harness)

    const response = (await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        { spec: 'unbound assignment', callerTerminalHandle: OUTSIDER_HANDLE },
        currentEvidence('worker'),
        'v-h2-unbound'
      )
    )) as { ok: false; error: { code: string } }

    expect(response.ok).toBe(false)
    expect(response.error.code).not.toBe('legacy_read_only')
    expect(response.error.code).toBe('run_required')
    expect(adoptedGraph(harness)).toEqual(before)
  })

  it('gives the SAME honest code through the gate path', async () => {
    const harness = createHarness()
    await legacyClaimsAdoptedRun(harness, 'v-h2b')
    await currentCoordinatorTakesOver(harness, 'v-h2b')
    harness.db.createRun({
      objective: 'elsewhere',
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })
    const before = adoptedGraph(harness)

    const response = (await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: harness.taskId, question: 'Proceed?', from: OUTSIDER_HANDLE },
        currentEvidence('worker'),
        'v-h2b-gate'
      )
    )) as { ok: false; error: { code: string } }

    expect(response.ok).toBe(false)
    expect(response.error.code).not.toBe('legacy_read_only')
    expect(adoptedGraph(harness)).toEqual(before)
  })
})

describe('#11745 H3 — adopted Run claimed by the legacy coordinator', () => {
  it('answers an unrelated unbound caller with run_required, not legacy_read_only', async () => {
    const harness = createHarness()
    await legacyClaimsAdoptedRun(harness, 'v-h3')
    expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)?.status).toBe('committed')
    const before = adoptedGraph(harness)

    const response = (await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        { spec: 'fresh assignment', callerTerminalHandle: OUTSIDER_HANDLE },
        currentEvidence('worker'),
        'v-h3-unbound'
      )
    )) as { ok: false; error: { code: string } }

    expect(response.ok).toBe(false)
    expect(response.error.code).not.toBe('legacy_read_only')
    expect(response.error.code).toBe('run_required')
    expect(adoptedGraph(harness)).toEqual(before)
  })

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

  it('fences the stale legacy coordinator on the gate path too', async () => {
    const harness = createHarness()
    await legacyClaimsAdoptedRun(harness, 'v-h3c')
    await currentCoordinatorTakesOver(harness, 'v-h3c')
    const before = adoptedGraph(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.gateCreate',
        { task: harness.taskId, question: 'Proceed?', from: COORDINATOR_HANDLE },
        evidence('coordinator'),
        'v-h3c-gate'
      )
    )

    expect(response).toMatchObject({ ok: false })
    expect(adoptedGraph(harness)).toEqual(before)
  })
})

describe('#11745 H4 — unattested caller on a taken-over adopted Run', () => {
  it('DOCUMENTS the accepted behaviour: the binding alone grants authority', async () => {
    const harness = createHarness()
    await legacyClaimsAdoptedRun(harness, 'v-h4')
    await currentCoordinatorTakesOver(harness, 'v-h4')

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'owner assignment',
          run: harness.adoptedRunId,
          callerTerminalHandle: CURRENT_COORDINATOR_HANDLE
        },
        unattested(currentEvidence('coordinator')),
        'v-h4-owner'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: { task: { run_id: harness.adoptedRunId } }
    })
  })

  it('refuses the same authority WITHOUT matching the run binding in evidence', async () => {
    const harness = createHarness()
    await legacyClaimsAdoptedRun(harness, 'v-h4b')
    await currentCoordinatorTakesOver(harness, 'v-h4b')

    // Why: evidence names a different terminal, so this is an impostor rather than the owner
    // ownsRunBinding is meant to admit. The attested handle must win over the declared one.
    const before = adoptedGraph(harness)
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'impostor assignment',
          run: harness.adoptedRunId,
          callerTerminalHandle: CURRENT_COORDINATOR_HANDLE
        },
        currentEvidence('worker'),
        'v-h4b-impostor'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(adoptedGraph(harness)).toEqual(before)
  })

  it('an unattested caller that is NOT the owner is still refused', async () => {
    const harness = createHarness()
    await legacyClaimsAdoptedRun(harness, 'v-h4c')
    await currentCoordinatorTakesOver(harness, 'v-h4c')
    const before = adoptedGraph(harness)

    const response = (await harness.dispatcher.dispatch(
      request(
        'orchestration.taskCreate',
        {
          spec: 'outsider assignment',
          run: harness.adoptedRunId,
          callerTerminalHandle: OUTSIDER_HANDLE
        },
        unattested(currentEvidence('worker')),
        'v-h4c-outsider'
      )
    )) as { ok: false; error: { code: string } }

    expect(response.ok).toBe(false)
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
  const task = before.createTask({ spec: 'legacy assignment', createdByTerminalHandle: 'term_old' })
  before.createDispatchContext(
    task.id,
    'term_old_worker',
    'tab_old:33333333-3333-4333-8333-333333333333'
  )
  const recovery = before.insertMessage({
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

  it('resolves a reminted tab half by leaf UUID', () => {
    const db = paneDb()
    const run = db.createRun({
      objective: 'reminted',
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: `tab_before:${leaf(1)}`
    })

    // Break-out remints the tab half; the leaf UUID is the durable identity.
    expect(db.getCurrentRunForPane(`tab_after:${leaf(1)}`)?.id).toBe(run.id)
    expect(db.getCurrentRunForPane(`tab_before:${leaf(1)}`)?.id).toBe(run.id)
    expect(db.getCurrentRunForPane(`tab_after:${leaf(2)}`)).toBeUndefined()
  })

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

    // A different first segment on an unparseable key must NOT match, even though the
    // indexed suffix is identical — the suffix only narrows, isEquivalentPaneKey decides.
    expect(db.getCurrentRunForPane(`other:tab:${leaf(3)}`)).toBeUndefined()
    expect(db.getCurrentRunForPane('other_empty:')).toBeUndefined()
    // A parseable key must not be satisfied by an unparseable row sharing its suffix.
    expect(db.getCurrentRunForPane(`tab:${leaf(3)}`)).toBeUndefined()
  })

  it('unbinds the equivalent pane when a reminted key binds a new Run', () => {
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

    expect(db.getRun(first.id)?.coordinator_pane_key).toBeNull()
    expect(db.getCurrentRunForPane(`tab_three:${leaf(4)}`)?.id).toBe(second.id)
  })

  it.each([60, 2000])('stays correct and fast at %i bound Runs', (total) => {
    const db = paneDb()
    for (let index = 0; index < total; index += 1) {
      db.createRun({
        objective: `run ${index}`,
        coordinatorHandle: `term_${index}`,
        coordinatorPaneKey: `tab_${index}:${leaf(index + 100)}`
      })
    }

    const target = `tab_reminted:${leaf(total + 99)}`
    const started = performance.now()
    for (let probe = 0; probe < 200; probe += 1) {
      expect(db.getCurrentRunForPane(target)).toBeDefined()
    }
    const elapsed = performance.now() - started

    // Generous ceiling: the pre-fix full-table scan at 2000 Runs was orders of magnitude slower.
    expect(elapsed).toBeLessThan(4000)
    expect(db.getCurrentRunForPane(`tab_missing:${leaf(999999)}`)).toBeUndefined()
  })
})
