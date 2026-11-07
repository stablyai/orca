import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { ORCHESTRATION_UNBOUND_RUN_ID as UNBOUND_RUN_ID } from '../../../../shared/orchestration-rpc-contract'

describe('writers require a Run', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  it('files a message without a Run under the unbound Run, never the legacy one', () => {
    const message = db.insertMessage({ from: 'sender', to: 'worker', subject: 'mail' })
    expect(message.run_id).toBe(UNBOUND_RUN_ID)
    expect(db.getRun(UNBOUND_RUN_ID)).toMatchObject({ legacy: 0 })
    expect(db.getUnreadMessages('worker').map((row) => row.id)).toEqual([message.id])
  })

  it('rejects a Task without a Run instead of using the legacy Run', () => {
    expect(() => db.createTask({ spec: 'work' })).toThrow('Run is required')
    expect(db.listTasks()).toEqual([])
  })

  it('rejects a decision gate without a Task before writing', () => {
    db.db.exec(`
      CREATE TRIGGER reject_gate_insert BEFORE INSERT ON decision_gates
      BEGIN SELECT RAISE(ABORT, 'gate insert reached'); END;
    `)
    expect(() => db.createGate({ taskId: 'missing', question: 'Proceed?' })).toThrow(
      'Task missing was not found while creating a decision gate.'
    )
    expect(db.listGates()).toEqual([])
  })
})
