import { describe, expect, it } from 'vitest'
import { boundRunAllowsPointer, listCrossRunUnread, withCrossRunUnread } from './cross-run-unread'
import { OrchestrationDb } from './db'

describe('cross-run unread', () => {
  it('lists sibling-run unread for the same coordinator and skips the bound run', () => {
    const db = new OrchestrationDb(':memory:')
    const paneKey = 'tab_same:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const stale = db.createRun({
      objective: 'Stale',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: paneKey
    })
    const bound = db.createRun({
      objective: 'Active',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: paneKey
    })
    db.insertMessage({
      from: 'worker',
      to: `run:${stale.id}`,
      subject: 'old worker_done',
      type: 'worker_done',
      runId: stale.id
    })
    db.insertMessage({
      from: 'worker',
      to: `run:${bound.id}`,
      subject: 'active mail',
      type: 'worker_done',
      runId: bound.id
    })
    db.insertMessage({
      from: 'other',
      to: `run:${stale.id}`,
      subject: 'someone else',
      type: 'status',
      runId: stale.id
    })
    const other = db.createRun({
      objective: 'Foreign',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    db.insertMessage({
      from: 'worker',
      to: `run:${other.id}`,
      subject: 'not ours',
      type: 'worker_done',
      runId: other.id
    })

    expect(listCrossRunUnread(db, 'term_coord', bound.id)).toEqual([{ runId: stale.id, count: 2 }])
    expect(
      withCrossRunUnread({ count: 0 }, listCrossRunUnread(db, 'term_coord', bound.id))
    ).toEqual({
      count: 0,
      crossRunUnread: [{ runId: stale.id, count: 2 }]
    })
    expect(boundRunAllowsPointer(db, `run:${bound.id}`)).toBe(true)
    expect(boundRunAllowsPointer(db, `run:${stale.id}`)).toBe(true)
    db.close()
  })

  it('blocks the idle pointer when peek on that Run would be empty', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Empty',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_empty:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    })
    expect(boundRunAllowsPointer(db, `run:${run.id}`)).toBe(false)
    expect(boundRunAllowsPointer(db, 'term_coord')).toBe(true)
    expect(listCrossRunUnread(db, 'term_coord', run.id)).toEqual([])
    db.close()
  })
})
