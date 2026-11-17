import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

const LEAF = '22222222-2222-4222-8222-222222222222'

describe('the current Run bound to a pane', () => {
  const databases: OrchestrationDb[] = []
  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  it('is the newest Run on an equivalent pane, never a newer suffix collision', () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    let seat = 0
    function run(paneKey: string) {
      return db.createRun({
        objective: paneKey,
        coordinatorHandle: `term_${seat++}`,
        coordinatorPaneKey: paneKey
      })
    }
    const exactOwner = run('tab_A:1')
    run('tab_B:1')
    run('tab_B:1')
    const leafOwner = run(`tab_old:${LEAF}`)
    const legacy = run(`tab_newer:${LEAF}`)
    db.db.prepare('UPDATE runs SET legacy = 1 WHERE id = ?').run(legacy.id)
    run(`:${LEAF}`)
    run(LEAF)

    expect(db.getCurrentRunForPane('tab_A:1')?.id).toBe(exactOwner.id)
    expect(db.getCurrentRunForPane(`tab_now:${LEAF}`)?.id).toBe(leafOwner.id)
    expect(db.getCurrentRunForPane('tab_A:2')).toBeUndefined()
  })
})
