import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

describe('mailbox pointer reservations (real sqlite)', () => {
  const createStore = () => new OrchestrationDb(':memory:')
  const rival = { ptyId: 'pty-rival', processIncarnation: 'rival:1' }
  const mine = { ptyId: 'pty-mine', processIncarnation: 'mine:1' }

  it('rolls the whole batch back when one row is already claimed', () => {
    const store = createStore()
    const free = store.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'free'
    })
    const taken = store.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'taken'
    })
    expect(store.stageMailboxPointerEnter([taken.id], rival)).toBe(true)

    expect(store.stageMailboxPointerEnter([free.id, taken.id], mine)).toBe(false)
    // A failed partial claim must leave the free row available to another flight.
    expect(store.stageMailboxPointerEnter([free.id], mine)).toBe(true)
  })
})
