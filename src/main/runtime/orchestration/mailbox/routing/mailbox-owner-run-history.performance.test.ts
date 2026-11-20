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

it.each([10, 100])(
  "held-mail retries over a coordinator's empty Run history (%i Runs) ask the Run index once until Run mail changes",
  (emptyRuns) => {
    const db = createDatabase('run-history-cost')
    databases.push(db)
    const owed = db.createRun({
      objective: 'owed',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    const mail = (runId: string) =>
      db.insertMessage({
        from: 'term_worker',
        to: `run:${runId}`,
        subject: 'held',
        type: 'status',
        runId,
        deliveryContract: 'current_delivery'
      })
    mail(owed.id)
    const later = db.createRun({
      objective: 'later',
      coordinatorHandle: 'term_later',
      coordinatorPaneKey: PANE_KEY
    })
    for (let index = 0; index < emptyRuns; index++) {
      // Earlier coordinators of this pane leave their Runs bound to it.
      db.createRun({
        objective: `empty ${index}`,
        coordinatorHandle: `term_earlier_${index}`,
        coordinatorPaneKey: PANE_KEY
      })
    }
    const owner = new OrchestrationMailboxOwner({
      getDb: () => db,
      getTerminal: () => null,
      getTerminalProcessIncarnation: () => null,
      onRoutedMessageTypes: () => {},
      onForeignMailboxRouted: () => {}
    })
    const terminal = {
      ptyId: PTY_ID,
      handle: TERMINAL_HANDLE,
      paneKeys: [PANE_KEY],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const historyQueries = vi.spyOn(db, 'runMailboxesWithPointerWorkForPane')
    for (let retry = 0; retry < 12; retry++) {
      expect(owner.resolveAll(terminal, { routeDirectMail: false })).toContain(`run:${owed.id}`)
    }
    expect(historyQueries).toHaveBeenCalledTimes(1)

    // Mail between terminals elsewhere owes no Run mailbox work.
    for (let message = 0; message < emptyRuns; message++) {
      db.insertMessage({
        from: 'term_sender',
        to: `term_unrelated_${message}`,
        subject: 'unrelated',
        type: 'status',
        deliveryContract: 'current_delivery'
      })
      owner.resolveAll(terminal, { routeDirectMail: false })
    }
    expect(historyQueries).toHaveBeenCalledTimes(1)

    mail(later.id)
    expect(owner.resolveAll(terminal, { routeDirectMail: false })).toContain(`run:${later.id}`)
    expect(historyQueries).toHaveBeenCalledTimes(2)
  }
)
