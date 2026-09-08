import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { migrateV40 } from './migrate-v40'
import { importFederatedControlMessage } from '../../federation-control-message'

describe('federated home Run migration', () => {
  const db = new OrchestrationDb(':memory:')
  afterEach(() => db.close())

  it('adds the home Run column and refuses mail for a development placeholder', () => {
    db.db.exec('ALTER TABLE remote_dispatch_attachments DROP COLUMN home_run_id')
    db.db.exec(`INSERT INTO remote_dispatch_attachments
      (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch)
      VALUES ('ctx_old', 'task_old', 'home', 'epoch')`)
    migrateV40.call(db, 39)
    expect(db.getRemoteDispatchAttachment('ctx_old')?.home_run_id).toBe('')
    expect(() =>
      importFederatedControlMessage(db, {
        dispatchId: 'ctx_old',
        messageId: 'message_old',
        payload: JSON.stringify({ from: 'home', subject: 'Instruction', body: '', type: 'message' })
      })
    ).toThrow('Run not found:')
    expect(db.getMessageById('message_old')).toBeUndefined()
  })
})
