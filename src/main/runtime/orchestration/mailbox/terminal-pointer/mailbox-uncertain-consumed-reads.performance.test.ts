import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { UncertainMailboxReconciliation } from './mailbox-pointer-resume'

const dbs: OrchestrationDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
})

// One Run's retained uncertain claims on this terminal, plus one in the mailbox the reads consume.
function reconciliation(retained: number) {
  const db = new OrchestrationDb(':memory:')
  dbs.push(db)
  const insert = db.db.prepare(
    `INSERT INTO messages (id, delivery_contract, from_handle, to_handle, subject, body,
       pointer_enter_pending, pointer_pty_id, pointer_process_incarnation)
     VALUES (?, 'current_delivery', 'term_worker', ?, 's', 'b', 3, 'pty-1', 'incarnation-1')`
  )
  db.db.exec('BEGIN')
  for (let index = 0; index < retained; index++) {
    insert.run(`msg_old_${index}`, 'run:old')
  }
  insert.run('msg_current', 'term:current')
  db.db.exec('COMMIT')
  const recounts = vi.spyOn(db, 'getPendingMailboxPointerMessagesForPty')
  const notices: string[][] = []
  const deps = {
    getDb: () => db,
    resolveSubmitTarget: () => ({ ptyId: 'pty-1', processIncarnation: 'incarnation-1' }),
    onDeliveryDecision: (_ptyId: string, decision?: { uncertainMailboxes?: string[] }) => {
      if (decision?.uncertainMailboxes) {
        notices.push(decision.uncertainMailboxes)
      }
    }
  }
  const state = { flightForPty: () => undefined }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reconciliation reads only these members.
  const reconciler = new UncertainMailboxReconciliation(deps as never, state as never)
  return { db, recounts, notices, reconciler }
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

it('reads of a named mailbox re-check only that mailbox, never the retained claims', async () => {
  for (const [retained, reads] of [
    [1_000, 100],
    [10_000, 1_000]
  ]) {
    const { db, recounts, notices, reconciler } = reconciliation(retained)
    reconciler.reconcile('pty-1')
    await flush()
    expect(notices.at(-1)).toEqual(['run:old', 'term:current'])

    db.markAsRead(['msg_current'])
    for (let read = 0; read < reads; read++) {
      reconciler.reconcileMailboxes('pty-1', ['term:current'])
      await flush()
    }
    expect(notices.at(-1)).toEqual(['run:old'])
    expect(notices).toHaveLength(2)
    expect(recounts).toHaveBeenCalledTimes(1)
  }
})
