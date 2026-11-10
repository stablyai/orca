import { expect, it } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'
import { buildCrewSnapshot } from './crew-party-snapshot'

it("puts each approval's newest message on its worker's row, and drops receipts once traffic is stale", () => {
  const { db, deps, run, assign } = fixture()
  const dispatch = assign('term_worker')
  const send = (approvalId: string, state: 'open' | 'answered') =>
    db.insertMessage({
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

  const [row] = buildCrewSnapshot('term_coord', deps).sections.managing
  expect(row.approvals?.map(({ approval }) => [approval.approvalId, approval.state])).toEqual([
    ['apr_answered', 'answered'],
    ['apr_open', 'open']
  ])
})
