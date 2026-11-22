import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

describe('task promotion query allocation', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const database of databases) {
      database.close()
    }
    databases.length = 0
  })

  function createDb(): OrchestrationDb {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    return database
  }

  it('leaves promotion inside the caller-owned transaction', () => {
    const db = createDb()
    const target = db.createTask({ runId: 'run_legacy_local', spec: 'Completing task' })
    const child = db.createTask({ runId: 'run_legacy_local', spec: 'Child', deps: [target.id] })
    db.db.exec('BEGIN IMMEDIATE')

    db.updateTaskStatus(target.id, 'completed', 'Inside outer transaction')

    expect(db.db.isTransaction).toBe(true)
    expect(db.getTask(child.id)?.status).toBe('ready')
    db.db.exec('ROLLBACK')
    expect(db.getTask(target.id)).toEqual(target)
    expect(db.getTask(child.id)).toEqual(child)
  })
})
