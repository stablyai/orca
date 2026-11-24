import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { OrchestrationMailboxOwner, type OrchestrationMailboxTerminal } from './mailbox-owner'

const PANE = 'tab:11111111-1111-4111-8111-111111111111'

it.each([100, 1_000])(
  'resolving a coordinator pane with %i retained Runs reads only its newest Run and the Runs with mail',
  (retained) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const runIds: string[] = []
      for (let index = 0; index < retained; index += 1) {
        runIds.push(
          db.createRun({
            objective: `run ${index}`,
            coordinatorHandle: null,
            coordinatorPaneKey: PANE
          }).id
        )
      }
      // One historical Run still has mail; it must stay deliverable.
      const owed = runIds[0]
      db.insertMessage({ runId: owed, from: 'worker', to: `run:${owed}`, subject: 'owed' })

      let runRows = 0
      const count =
        <A extends unknown[], R>(read: (...args: A) => R, size: (value: R) => number) =>
        (...args: A): R => {
          const value = read(...args)
          runRows += size(value)
          return value
        }
      // Bind the real reads before spying, so each spy counts and then calls through.
      const allBound = count(db.runsBoundToPane.bind(db), (rows) => rows.length)
      const firstBound = count(db.firstRunBoundToPane.bind(db), (row) => (row ? 1 : 0))
      const withMail = count(db.runIdsWithPointerWorkBoundToPane.bind(db), (ids) => ids.length)
      vi.spyOn(db, 'runsBoundToPane').mockImplementation(allBound)
      vi.spyOn(db, 'firstRunBoundToPane').mockImplementation(firstBound)
      vi.spyOn(db, 'runIdsWithPointerWorkBoundToPane').mockImplementation(withMail)
      const owner = new OrchestrationMailboxOwner({
        getDb: () => db,
        getTerminal: () => null,
        getTerminalProcessIncarnation: () => null,
        onRoutedMessageTypes: () => {},
        onForeignMailboxRouted: () => {}
      })
      const terminal: OrchestrationMailboxTerminal = {
        ptyId: 'pty',
        handle: 'term_coordinator',
        paneKeys: [PANE],
        lastAgentStatus: 'idle',
        lastAgentStatusObservedLive: true
      }

      const checks = 10
      for (let check = 0; check < checks; check += 1) {
        expect(owner.resolveAll(terminal)).toEqual([`run:${runIds.at(-1)}`, `run:${owed}`])
      }
      // Each check reads the newest Run once and the one Run with mail, not every retained Run.
      expect(runRows).toBeLessThanOrEqual(2 * checks)
      // The mail check starts from mail awaiting delivery and looks each Run up by key: no Run scan.
      const prepare = vi.spyOn(db.db, 'prepare')
      db.runIdsWithPointerWorkBoundToPane(PANE)
      const sql = String(prepare.mock.calls.at(-1)?.[0])
      prepare.mockRestore()
      const plan = db.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all('11111111-1111-4111-8111-111111111111')
        .map((row) => String(row.detail))
      expect(plan.some((step) => /idx_messages_/.test(step))).toBe(true)
      expect(plan.filter((step) => /\bruns\b/.test(step))).toEqual([
        expect.stringMatching(/^SEARCH runs USING .*\(id=\?\)$/)
      ])
    } finally {
      db.close()
      vi.restoreAllMocks()
    }
  }
)
