import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'

describe('forgetRunCoordinatorHandlesExcept', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  function openHandleRun(objective: string): string {
    // A synthetic handle-only coordinator (no pane, no session) — the voice control's shape.
    return db.createRun({ objective, coordinatorHandle: 'voice-control', coordinatorPaneKey: null })
      .id
  }

  it('leaves exactly the kept run addressable by the bare handle', () => {
    db = new OrchestrationDb(':memory:')
    const first = openHandleRun('session one')
    const second = openHandleRun('session two')
    // Without cleanup every session piles onto the cache (createRun's unbind matches on
    // pane/session identity, which a handle-only coordinator does not have).
    expect(db.getRunMailboxOwnerIdsForHandle('voice-control').toSorted()).toEqual(
      [first, second].toSorted()
    )

    db.forgetRunCoordinatorHandlesExcept('voice-control', second)

    expect(db.getRunMailboxOwnerIdsForHandle('voice-control')).toEqual([second])
    // Other handles are untouched.
    const other = db.createRun({
      objective: 'someone else',
      coordinatorHandle: 'someone-else',
      coordinatorPaneKey: null
    }).id
    db.forgetRunCoordinatorHandlesExcept('voice-control', second)
    expect(db.getRunMailboxOwnerIdsForHandle('someone-else')).toEqual([other])
  })
})
