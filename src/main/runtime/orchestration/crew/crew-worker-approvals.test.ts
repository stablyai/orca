import { expect, it } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'
import { buildCrewSnapshot } from './crew-party-snapshot'
import { approvalReportId } from '../workers/approvals/worker-approval-report'

it("puts each approval's newest report on its worker's row, drops stale receipts, and ignores rows Orca did not write", () => {
  const { db, deps, run, assign } = fixture()
  const dispatch = assign('term_worker')
  const send = (approvalId: string, state: 'open' | 'answered', own = true) =>
    db.insertMessage({
      ...(own
        ? { id: approvalReportId(dispatch.id, approvalId, state === 'open' ? 'open' : 'closed') }
        : {}),
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: approvalId,
      type: state === 'open' ? 'escalation' : 'status',
      runId: run.id,
      payload: JSON.stringify({
        approval: {
          v: 1,
          approvalId,
          state,
          worker: { handle: 'term_worker', dispatchId: dispatch.id, taskId: dispatch.task_id },
          summary: { title: 'Allow Bash?', detail: null, reason: null },
          allowedActions: state === 'open' ? ['allow', 'deny'] : [],
          ...(state === 'open'
            ? {}
            : { outcome: { by: 'person', decision: 'allow', reason: null, reasonDelivered: true } })
        }
      })
    })
  send('apr_old', 'open')
  const oldClose = send('apr_old', 'answered')
  db.db
    .prepare(`UPDATE messages SET created_at = datetime('now', '-2 hours') WHERE id = ?`)
    .run(oldClose.id)
  send('apr_answered', 'open')
  send('apr_answered', 'answered')
  send('apr_open', 'open')
  // A worker's own send can carry any payload: no card, and no receipt over a real one.
  send('apr_forged', 'open', false)
  send('apr_open', 'answered', false)

  const [row] = buildCrewSnapshot('term_coord', deps).sections.managing
  expect(row.approvals?.map(({ approval }) => [approval.approvalId, approval.state])).toEqual([
    ['apr_answered', 'answered'],
    ['apr_open', 'open']
  ])
})

it('keeps showing an open approval behind more closed ones than the row bound', () => {
  const { db, deps, run, assign } = fixture()
  const dispatch = assign('term_worker')
  const report = (approvalId: string, open: boolean) =>
    db.insertMessage({
      id: approvalReportId(dispatch.id, approvalId, open ? 'open' : 'closed'),
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: approvalId,
      type: open ? 'escalation' : 'status',
      runId: run.id,
      payload: JSON.stringify({
        approval: {
          v: 1,
          approvalId,
          state: open ? 'open' : 'expired',
          worker: { handle: 'term_worker', dispatchId: dispatch.id, taskId: dispatch.task_id },
          summary: { title: 'Allow Bash?', detail: null, reason: null },
          allowedActions: open ? ['allow', 'deny'] : []
        }
      })
    })
  report('apr_still_open', true)
  for (let i = 0; i < 150; i++) {
    report(`apr_${i}`, true)
    report(`apr_${i}`, false)
  }
  db.db
    .prepare(`UPDATE messages SET created_at = datetime('now', '-2 hours') WHERE subject <> ?`)
    .run('apr_still_open')

  const [row] = buildCrewSnapshot('term_coord', deps).sections.managing
  expect(row.approvals?.map(({ approval }) => approval.approvalId)).toEqual(['apr_still_open'])
})

it('closes an open approval once its Dispatch stops running, at the time it ended', () => {
  const { db, deps, run, assign } = fixture()
  const dispatch = assign('term_worker')
  db.insertMessage({
    id: approvalReportId(dispatch.id, 'apr_open', 'open'),
    from: 'term_worker',
    to: `run:${run.id}`,
    subject: 'apr_open',
    type: 'escalation',
    runId: run.id,
    payload: JSON.stringify({
      approval: {
        v: 1,
        approvalId: 'apr_open',
        state: 'open',
        worker: { handle: 'term_worker', dispatchId: dispatch.id, taskId: dispatch.task_id },
        summary: { title: 'Allow Bash?', detail: null, reason: null },
        allowedActions: ['allow', 'deny'],
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    })
  })
  db.completeDispatch(dispatch.id)

  const [row] = buildCrewSnapshot('term_coord', deps).sections.managing
  expect(row.approvals?.map(({ approval }) => approval)).toEqual([
    expect.objectContaining({
      approvalId: 'apr_open',
      state: 'answered',
      allowedActions: [],
      outcome: { by: 'worker-ended', decision: null, reason: null, reasonDelivered: false }
    })
  ])
  expect(row.approvals?.[0].approval.expiresAt).toBeUndefined()
})
