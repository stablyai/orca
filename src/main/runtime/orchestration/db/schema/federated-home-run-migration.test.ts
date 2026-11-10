import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION, federatedStubHomeRunId } from '../contract-constants'
import { importFederatedControlMessage } from '../../legacy-remote/federation-control-message'

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
