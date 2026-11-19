import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationMailboxOwner } from './mailbox-owner'
import {
  createDatabase,
  PANE_KEY,
  PTY_ID,
  TERMINAL_HANDLE
} from '../terminal-pointer/orchestration-mailbox-notification-test-harness'
import type { OrchestrationDb } from '../../db/orchestration-db'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

/** Run rows handed back to JavaScript, which is what a pane's growing Run history would cost. */
function countRunRows(db: OrchestrationDb): () => number {
  const bound = vi.spyOn(db, 'runsBoundToPane')
  const withWork = vi.spyOn(db, 'runMailboxesWithPointerWorkForPane')
  const current = vi.spyOn(db, 'getCurrentRunForPane')
  const sum = (lengths: number[]): number => lengths.reduce((total, length) => total + length, 0)
  return () =>
    sum(
      bound.mock.results.map((result) => (Array.isArray(result.value) ? result.value.length : 0))
    ) +
    sum(
      withWork.mock.results.map((result) => (Array.isArray(result.value) ? result.value.length : 0))
    ) +
    current.mock.results.filter((result) => result.value !== undefined).length
}

it.each([10, 100])(
  "a coordinator's empty Run history (%i Runs) adds no rows to finding which of its mailboxes owe mail",
  (emptyRuns) => {
    const db = createDatabase('run-history-cost')
    databases.push(db)
    const owed = db.createRun({
      objective: 'owed',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    db.insertMessage({
      from: 'term_worker',
      to: `run:${owed.id}`,
      subject: 'held',
      type: 'status',
      runId: owed.id,
      deliveryContract: 'current_delivery'
    })
    for (let index = 0; index < emptyRuns; index++) {
      // Earlier coordinators of this pane leave their Runs bound to it.
      db.createRun({
        objective: `empty ${index}`,
        coordinatorHandle: `term_earlier_${index}`,
        coordinatorPaneKey: PANE_KEY
      })
    }
    expect(db.runsBoundToPane(PANE_KEY).length).toBeGreaterThanOrEqual(emptyRuns)
    const owner = new OrchestrationMailboxOwner({
      getDb: () => db,
      getTerminal: () => null,
      getTerminalProcessIncarnation: () => null,
      onRoutedMessageTypes: () => {},
      onForeignMailboxRouted: () => {}
    })
    const runRows = countRunRows(db)
    const mailboxes = owner.resolveAll(
      {
        ptyId: PTY_ID,
        handle: TERMINAL_HANDLE,
        paneKeys: [PANE_KEY],
        lastAgentStatus: 'idle',
        lastAgentStatusObservedLive: true
      },
      { routeDirectMail: false }
    )
    expect(mailboxes).toContain(`run:${owed.id}`)
    expect(runRows()).toBeLessThanOrEqual(2)
  }
)
