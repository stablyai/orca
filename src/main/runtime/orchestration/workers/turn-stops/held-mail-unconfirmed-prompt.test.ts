import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { reportMailHeldWithoutPaint } from './held-mail-unconfirmed-prompt'
import { observeWorker } from './worker-presence-report'

function heldWorker() {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'held mail',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  const dispatch = createRootDispatch(
    db,
    task.id,
    'term_worker',
    makePaneKey('tab-worker', '11111111-1111-4111-8111-111111111111')
  )
  const deps = { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() }
  const mail = (subject: string) =>
    db
      .getUnreadRunMailbox(run.id, 100, ['escalation'])
      .filter((message) => message.subject === subject)
  return { db, dispatch, deps, mail }
}

it('tells the coordinator once per hold and leaves the worker’s own rest reports alone', () => {
  const { db, dispatch, deps, mail } = heldWorker()
  const rest = {
    presence: 'at-rest' as const,
    fence: 'term_worker:1',
    legacyStopKey: 'rest',
    rest: { from: 'term_worker', reason: 'finished' as const, lastOutput: undefined }
  }
  observeWorker(db, { kind: 'local', dispatch }, rest, deps)
  expect(mail('Worker stopped without reporting')).toHaveLength(1)

  reportMailHeldWithoutPaint(db, dispatch.id, 'mail-held:inc-1:491', deps)
  reportMailHeldWithoutPaint(db, dispatch.id, 'mail-held:inc-1:491', deps)
  expect(mail('Mail to a worker is held after Orca restarted')).toHaveLength(1)
  expect(mail('Mail to a worker is held after Orca restarted')[0]?.body).toContain(
    `orchestration worker-stop --dispatch ${dispatch.id}`
  )

  // The same rest seen again (a restart re-reads it) is still the one already reported.
  observeWorker(db, { kind: 'local', dispatch }, rest, deps)
  expect(mail('Worker stopped without reporting')).toHaveLength(1)

  // A hold after output since (a later restart) is a new one.
  reportMailHeldWithoutPaint(db, dispatch.id, 'mail-held:inc-1:902', deps)
  expect(mail('Mail to a worker is held after Orca restarted')).toHaveLength(2)
  db.close()
})

it('settles a hold with nobody to tell at once, so rechecks do not retry it', () => {
  const db = new OrchestrationDb(':memory:')
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'earlier work' })
  const dispatch = createRootDispatch(
    db,
    task.id,
    'term_worker',
    makePaneKey('tab-worker', '33333333-3333-4333-8333-333333333333')
  )
  const deps = { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() }
  // A legacy Run with no active coordinator: the report has no recipient.
  expect(reportMailHeldWithoutPaint(db, dispatch.id, 'mail-held:inc-1:7', deps)).toBe(true)
  expect(deps.notify).not.toHaveBeenCalled()
  db.close()
})
