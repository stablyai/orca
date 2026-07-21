import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('dispatch failure policy', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  it('terminally fails a task when no retry owner exists', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'unattended' })
    const dispatch = db.createDispatchContext(task.id, 'term_a')

    const failed = db.failDispatch(dispatch.id, 'Agent exited with code -1', {
      requeueTask: false
    })

    expect(failed).toMatchObject({
      status: 'failed',
      failure_count: 1,
      last_failure: 'Agent exited with code -1'
    })
    expect(db.getTask(task.id)).toMatchObject({
      status: 'failed',
      result: 'Agent exited with code -1'
    })
  })
})
