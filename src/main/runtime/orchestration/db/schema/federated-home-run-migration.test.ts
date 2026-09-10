import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/protocol-version'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION, federatedStubHomeRunId } from '../contract-constants'
import { migrateV40 } from './migrate-v40'
import { importFederatedControlMessage } from '../../federation-control-message'

describe('federated home Run migration', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function importInstruction(target: OrchestrationDb, dispatchId: string, messageId: string): void {
    expect(
      importFederatedControlMessage(target, {
        dispatchId,
        messageId,
        payload: JSON.stringify({ from: 'home', subject: 'Instruction', body: '', type: 'status' })
      })
    ).toEqual({ imported: true, type: 'status' })
  }

  function attachWithoutRunId(target: OrchestrationDb, dispatchId: string, runId?: string): void {
    target.createRemoteDispatchAttachment({
      dispatchId,
      runId,
      taskId: `task_${dispatchId}`,
      homePeerFingerprint: 'home',
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: 'epoch',
      mutationReceipt: {
        callerFingerprint: 'home',
        requestId: `request_${dispatchId}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: `payload_${dispatchId}`
      }
    })
  }

  it('backfills a pre-upgrade attachment with a stub home Run that keeps its mailbox', () => {
    db.db.exec('ALTER TABLE remote_dispatch_attachments DROP COLUMN home_run_id')
    db.db.exec(`INSERT INTO remote_dispatch_attachments
      (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch)
      VALUES ('ctx_old', 'task_old', 'home', 'epoch')`)
    migrateV40.call(db, 39)
    const stubRunId = federatedStubHomeRunId('ctx_old')
    expect(db.getRemoteDispatchAttachment('ctx_old')?.home_run_id).toBe(stubRunId)
    expect(db.getRunRaw(stubRunId)).toMatchObject({ home_database: 'remote', legacy: 0 })
    importInstruction(db, 'ctx_old', 'message_old')
    expect(db.getMessageById('message_old')?.run_id).toBe(stubRunId)
  })

  it('mints a stub home Run when a v1.4.198 coordinator attaches without a Run id', () => {
    attachWithoutRunId(db, 'ctx_legacy_home')
    const stubRunId = federatedStubHomeRunId('ctx_legacy_home')
    expect(db.getRemoteDispatchAttachment('ctx_legacy_home')?.home_run_id).toBe(stubRunId)
    importInstruction(db, 'ctx_legacy_home', 'message_legacy_home')
    expect(db.getMessageById('message_legacy_home')?.run_id).toBe(stubRunId)
  })

  it('rejects a whitespace-only Run id instead of minting a stub', () => {
    expect(() => attachWithoutRunId(db, 'ctx_blank', '   ')).toThrow('Missing Run ID')
    expect(db.getRemoteDispatchAttachment('ctx_blank')).toBeUndefined()
  })

  it('repairs rows a rolled-back v1.4.198 host inserted after user_version reached 40', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-federated-home-run-'))
    const dbPath = join(dir, 'orchestration.db')
    try {
      const upgraded = new OrchestrationDb(dbPath)
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      // v1.4.198's insert shape: no home_run_id column, so the DEFAULT '' lands.
      upgraded.db.exec(`INSERT INTO remote_dispatch_attachments
        (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch)
        VALUES ('ctx_rolled_back', 'task_rolled_back', 'home', 'epoch')`)
      expect(upgraded.getRemoteDispatchAttachment('ctx_rolled_back')?.home_run_id).toBe('')
      expect(() =>
        importFederatedControlMessage(upgraded, {
          dispatchId: 'ctx_rolled_back',
          messageId: 'message_refused',
          payload: JSON.stringify({ from: 'home', subject: 'x', body: '', type: 'status' })
        })
      ).toThrow(/Run not found/)
      upgraded.close()

      const reopened = new OrchestrationDb(dbPath)
      try {
        const stubRunId = federatedStubHomeRunId('ctx_rolled_back')
        expect(reopened.getRemoteDispatchAttachment('ctx_rolled_back')?.home_run_id).toBe(stubRunId)
        expect(reopened.getRunRaw(stubRunId)).toMatchObject({ home_database: 'remote', legacy: 0 })
        importInstruction(reopened, 'ctx_rolled_back', 'message_rolled_back')
        expect(reopened.getMessageById('message_rolled_back')?.run_id).toBe(stubRunId)
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
