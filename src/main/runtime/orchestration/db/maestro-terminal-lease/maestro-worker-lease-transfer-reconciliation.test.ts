import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'
import { reconcileMaestroWorkerLeaseTransfer } from './maestro-worker-lease-transfer-reconciliation'

describe('Maestro worker lease transfer reconciliation', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('reconciles one committed transfer after restart without mutating ownership', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-transfer-reconcile-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources (
        id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
        process_incarnation, ownership_state, release_state
      ) VALUES ('wtr_1', 'ctx_old', 'ctx_old', 'term_1', 'tab_1:leaf_1', 'pty_1', 'owned', 'not_requested')`
      )
      .run()
    const predecessor = db.reserveMaestroTerminalLease({
      requestId: 'worker:old',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: 'run_1',
      taskId: 'task_1',
      attemptId: 'attempt_1',
      role: 'worker',
      workerTerminalResourceId: 'wtr_1',
      title: 'worker',
      launchProfile: {
        agent: 'codex',
        model: null,
        effort: null,
        permissionMode: 'yolo',
        routeRef: null
      },
      spawnedBy: 'coordinator:g1',
      ownerPrincipal: 'dispatch:ctx_old',
      retentionPolicy: 'auto_release'
    })
    db.attachMaestroTerminalLease({
      leaseId: predecessor.id,
      terminalHandle: 'term_1',
      tabId: 'tab_1',
      paneKey: 'tab_1:leaf_1',
      ptyIncarnation: 'pty_1',
      processRootId: 'pid_1'
    })
    db.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'ready' })
    db.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'active' })
    const receipt = db.transferMaestroWorkerTerminalLease({
      requestId: 'transfer:1',
      predecessorLeaseId: predecessor.id,
      successorRequestId: 'worker:new',
      kind: 'strict_retry',
      successorDispatchId: 'ctx_new',
      runId: 'run_1',
      taskId: 'task_1',
      attemptId: 'attempt_1',
      terminalHandle: 'term_1',
      paneKey: 'tab_1:leaf_1',
      ptyIncarnation: 'pty_1',
      processRootId: 'pid_1',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      hostScope: null,
      predecessorOwnerPrincipal: 'dispatch:ctx_old',
      successorOwnerPrincipal: 'dispatch:ctx_new',
      coordinatorGeneration: null,
      retentionPolicy: 'auto_release',
      title: 'worker',
      launchProfile: {
        agent: 'codex',
        model: null,
        effort: null,
        permissionMode: 'yolo',
        routeRef: null
      },
      spawnedBy: 'coordinator:g1'
    })
    db.close()
    const reopenedDb = new OrchestrationDb(dbPath)
    db = reopenedDb

    expect(
      reconcileMaestroWorkerLeaseTransfer({ db: reopenedDb, requestId: 'transfer:1' })
    ).toEqual(receipt)
    expect(
      reopenedDb.db
        .prepare(
          `SELECT count(*) AS count FROM maestro_terminal_leases
         WHERE role = 'worker' AND lifecycle_state NOT IN ('released', 'superseded', 'archived')
           AND worker_terminal_resource_id = 'wtr_1'`
        )
        .get()
    ).toEqual({ count: 1 })
    reopenedDb.db
      .prepare(
        "UPDATE worker_terminal_resources SET owner_dispatch_id = 'ctx_bad' WHERE id = 'wtr_1'"
      )
      .run()
    expect(() =>
      reconcileMaestroWorkerLeaseTransfer({ db: reopenedDb, requestId: 'transfer:1' })
    ).toThrow(/does not match durable ownership/)
    const stored = reopenedDb.db
      .prepare(
        'SELECT receipt_json FROM maestro_terminal_lease_transfer_receipts WHERE request_id = ?'
      )
      .get('transfer:1') as { receipt_json: string }
    const tampered = JSON.parse(stored.receipt_json) as { requestId: string }
    tampered.requestId = 'transfer:tampered'
    reopenedDb.db
      .prepare(
        'UPDATE maestro_terminal_lease_transfer_receipts SET receipt_json = ? WHERE request_id = ?'
      )
      .run(JSON.stringify(tampered), 'transfer:1')
    expect(() => reopenedDb.getMaestroWorkerLeaseTransferReceipt('transfer:1')).toThrow(
      /request identity differs/
    )
  })
})
