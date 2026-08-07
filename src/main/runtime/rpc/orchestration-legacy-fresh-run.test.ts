import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import Database from '../../sqlite/sync-database'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'

const WORKER_HANDLE = 'term_legacy_worker'
const WORKER_PANE = 'tab_worker:33333333-3333-4333-8333-333333333333'
const COORDINATOR_HANDLE = 'term_legacy_coord'
const COORDINATOR_PANE = 'tab_coord:44444444-4444-4444-8444-444444444444'
const CURRENT_COORDINATOR_HANDLE = 'term_current_coord'
const CURRENT_COORDINATOR_PANE = 'tab_current:55555555-5555-4555-8555-555555555555'
// The replacement coordinator after a retain/restart: same handle, new pane identity.
const RESTARTED_COORDINATOR_PANE = 'tab_current:99999999-9999-4999-8999-999999999999'
const FRESH_COORDINATOR_HANDLE = 'term_fresh_coord'
const FRESH_COORDINATOR_PANE = 'tab_fresh:66666666-6666-4666-8666-666666666666'

type Harness = {
  db: OrchestrationDb
  dispatcher: RpcDispatcher
  runtime: OrcaRuntimeService
  adoptedRunId: string
  taskId: string
  dispatchId: string
  freshRunId: string
}

const tempDirs: string[] = []
const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'orca-legacy-fresh-run-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'orchestration.db')
  const before = new OrchestrationDb(dbPath)
  const task = before.createTask({
    spec: 'legacy assignment',
    createdByTerminalHandle: COORDINATOR_HANDLE
  })
  const dispatch = before.createDispatchContext(task.id, WORKER_HANDLE, WORKER_PANE)
  before.close()

  const raw = new Database(dbPath)
  raw.exec(`
    UPDATE dispatch_contexts SET process_incarnation = 'process-1';
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
  const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
  const freshRun = db.createRun({
    objective: 'fresh work',
    coordinatorHandle: FRESH_COORDINATOR_HANDLE,
    coordinatorPaneKey: FRESH_COORDINATOR_PANE
  })
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === COORDINATOR_HANDLE
      ? COORDINATOR_PANE
      : handle === WORKER_HANDLE
        ? WORKER_PANE
        : handle === CURRENT_COORDINATOR_HANDLE
          ? CURRENT_COORDINATOR_PANE
          : handle === FRESH_COORDINATOR_HANDLE
            ? FRESH_COORDINATOR_PANE
            : null
  )
  vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((proof) => {
    const valid =
      (proof?.terminalHandle === WORKER_HANDLE && proof.paneKey === WORKER_PANE) ||
      (proof?.terminalHandle === COORDINATOR_HANDLE && proof.paneKey === COORDINATOR_PANE) ||
      (proof?.terminalHandle === CURRENT_COORDINATOR_HANDLE &&
        proof.paneKey === CURRENT_COORDINATOR_PANE) ||
      (proof?.terminalHandle === FRESH_COORDINATOR_HANDLE &&
        proof.paneKey === FRESH_COORDINATOR_PANE)
    if (!valid || !proof?.launchToken) {
      return null
    }
    return {
      hostScope: { kind: 'local', hostId: 'local' },
      terminalHandle: proof.terminalHandle as string,
      paneKey: proof.paneKey as string,
      processIncarnation: 'process-1',
      launchTokenHash: createHash('sha256').update(proof.launchToken).digest('hex')
    }
  })
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  return {
    db,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
    runtime,
    adoptedRunId,
    taskId: task.id,
    dispatchId: dispatch.id,
    freshRunId: freshRun.id
  }
}

function evidence(
  role: 'worker' | 'coordinator' | 'current-coordinator' | 'fresh-coordinator'
): OrchestrationCompatibilityEvidence {
  const map = {
    worker: { handle: WORKER_HANDLE, pane: WORKER_PANE },
    coordinator: { handle: COORDINATOR_HANDLE, pane: COORDINATOR_PANE },
    'current-coordinator': { handle: CURRENT_COORDINATOR_HANDLE, pane: CURRENT_COORDINATOR_PANE },
    'fresh-coordinator': { handle: FRESH_COORDINATOR_HANDLE, pane: FRESH_COORDINATOR_PANE }
  }
  const entry = map[role]
  return {
    terminalHandle: entry.handle,
    paneKey: entry.pane,
    launchToken: `${role}-token`
  }
}

function request(
  method: string,
  params: unknown,
  proof: OrchestrationCompatibilityEvidence,
  invocationId: string
): RpcRequest {
  return {
    id: `rpc_${invocationId}`,
    authToken: 'caller-token',
    method,
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: invocationId,
    compatibilityInvocationId: invocationId,
    orchestrationCompatibilityEvidence: proof
  }
}

describe('legacy compatibility with fresh-run coordinators', () => {
  it('lets a fresh-run coordinator list tasks without --run despite a legacy adoption', async () => {
    const harness = createHarness()

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskList',
        { callerTerminalHandle: FRESH_COORDINATOR_HANDLE },
        evidence('fresh-coordinator'),
        'fresh-task-list'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: { runId: harness.freshRunId, legacyReadOnly: false }
    })
  })

  it('lets a fresh-run coordinator send status messages without legacy_read_only', async () => {
    const harness = createHarness()
    const freshTask = harness.db.createTask({
      spec: 'fresh task',
      runId: harness.freshRunId,
      createdByTerminalHandle: FRESH_COORDINATOR_HANDLE
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          from: FRESH_COORDINATOR_HANDLE,
          to: `run:${harness.freshRunId}`,
          subject: 'fresh status',
          type: 'status'
        },
        evidence('fresh-coordinator'),
        'fresh-send-status'
      )
    )

    expect(response).toMatchObject({ ok: true })
    expect(harness.db.getTask(freshTask.id)?.status).toBe('ready')
  })
})

function takeOverWithCommittedPrincipal(harness: Harness): void {
  harness.db.commitLegacyCompatibilityPrincipal({
    runId: harness.adoptedRunId,
    role: 'coordinator',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    terminalHandle: COORDINATOR_HANDLE,
    paneKey: COORDINATOR_PANE,
    launchTokenHash: 'coord-hash',
    processIncarnation: 'process-1'
  })
  harness.db.bindRun({
    runId: harness.adoptedRunId,
    coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
    coordinatorPaneKey: CURRENT_COORDINATOR_PANE,
    takeoverLegacy: true
  })
}

describe('legacy coordinator delivery targets after takeover', () => {
  it('accepts both the old and new coordinator handles after principal revocation', () => {
    const harness = createHarness()
    takeOverWithCommittedPrincipal(harness)

    expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)?.status).toBe('revoked')

    // Old handle still routable (retained).
    expect(
      harness.db.isLegacyCoordinatorDeliveryTarget(harness.adoptedRunId, COORDINATOR_HANDLE)
    ).toBe(true)
    // New handle also routable (current binding).
    expect(
      harness.db.isLegacyCoordinatorDeliveryTarget(harness.adoptedRunId, CURRENT_COORDINATOR_HANDLE)
    ).toBe(true)
    // Unknown handle not routable.
    expect(harness.db.isLegacyCoordinatorDeliveryTarget(harness.adoptedRunId, 'term_unknown')).toBe(
      false
    )
  })

  it('keeps the caller-side fence out of the replacement coordinator jurisdiction', async () => {
    const harness = createHarness()
    takeOverWithCommittedPrincipal(harness)

    // The replacement coordinator is a delivery target, but must never become fence jurisdiction:
    // fencing it would replace an actionable error with unusable takeover guidance.
    expect(
      harness.db.isLegacyCoordinatorHandle(harness.adoptedRunId, CURRENT_COORDINATOR_HANDLE)
    ).toBe(false)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskList',
        { callerTerminalHandle: CURRENT_COORDINATOR_HANDLE },
        { ...evidence('current-coordinator'), paneKey: RESTARTED_COORDINATOR_PANE },
        'replacement-coordinator-not-fenced'
      )
    )

    expect(response).not.toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
  })

  it('lets a worker send worker_done to the new coordinator after principal revocation', async () => {
    const harness = createHarness()
    takeOverWithCommittedPrincipal(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          from: WORKER_HANDLE,
          to: CURRENT_COORDINATOR_HANDLE,
          subject: 'Completed',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: harness.taskId,
            dispatchId: harness.dispatchId,
            outcome: 'succeeded'
          })
        },
        evidence('worker'),
        'worker-done-to-new-coordinator'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        message: {
          to_handle: `run:${harness.adoptedRunId}`,
          delivery_contract: 'current_delivery',
          type: 'worker_done'
        }
      }
    })
  })
})
