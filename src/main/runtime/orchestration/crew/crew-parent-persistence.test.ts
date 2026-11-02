import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ensureMutationReceiptCapacity } from '../mutation-receipt-capacity'
import { federatedStubHomeRunId } from '../db/contract-constants'
import { buildCrewSnapshot, CrewReadModel } from './crew-read-model'
import { subscribeCrew } from './crew-stream'
import { fixture } from './crew-read-model.test-fixture'

it('reconstructs old-writer stub parents after real receipt pruning and reopen, and separates reset scopes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-crew-parent-'))
  const path = join(dir, 'orchestration.db')
  const { deps, handles } = fixture()
  const workerProcess = deps.processForHandle?.('term_worker')
  if (typeof workerProcess !== 'string' || workerProcess.length === 0) {
    throw new Error('Expected the current fixture worker process')
  }
  let db = new OrchestrationDb(path)
  try {
    // Supported rollback writer shape: empty home_run_id is repaired only by normal DB open.
    db.db
      .prepare(`INSERT INTO remote_dispatch_attachments
      (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, terminal_handle, pane_key, process_incarnation, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded')`)
      .run(
        'ctx_old_writer',
        'task_old',
        'home',
        'epoch',
        'term_worker',
        handles.get('term_worker')!,
        workerProcess
      )
    db.db
      .prepare(`INSERT INTO mutation_receipts
      (caller_fingerprint, request_id, method, payload_hash, state, updated_at)
      VALUES ('home', 'old', 'orchestration.federationAttachStart', 'hash', 'completed', '2000-01-01')`)
      .run()
    ensureMutationReceiptCapacity(db.db)
    expect(db.getMutationReceipt('home', 'old')).toBeUndefined()
    db.close()
    db = new OrchestrationDb(path)
    deps.db = db
    const stub = federatedStubHomeRunId('ctx_old_writer')
    expect(db.getRunRaw(stub)?.home_database).toBe('remote')
    expect(db.getRemoteDispatchAttachment('ctx_old_writer')?.process_incarnation).toBe(
      workerProcess
    )
    const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
    let current = buildCrewSnapshot('term_worker', deps)
    const stop = subscribeCrew(
      () => {
        current = model.read('term_worker')
        return current
      },
      model.subscribe,
      () => {}
    )
    try {
      const before = current.sections.managedBy
      expect(before.map((row) => row.partyKey)).toEqual([JSON.stringify(['home', `run:${stub}`])])
      expect(before[0]).toMatchObject({ role: 'manager' })
      expect(before[0]).not.toHaveProperty('sendAddress')
      expect(before[0].openTarget).toBeUndefined()
      db.resetMessages()
      await Promise.resolve()
      await Promise.resolve()
      expect(current.sections.managedBy).toEqual(before)
      db.resetTasks()
      await Promise.resolve()
      await Promise.resolve()
      expect(current.sections.managedBy).toEqual([])
      db.resetAll()
      await Promise.resolve()
      await Promise.resolve()
      expect(current.status).toBe('ok')
    } finally {
      stop()
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
