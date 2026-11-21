import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { parseOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { sleepingMailOwnerMailboxes } from './sleeping-mail-owner-mailboxes'
import { selectOrchestrationPointerSequence } from '../terminal-pointer/mailbox-pointer-eligibility'
import { countDiscoveryRows } from './sleeping-mail-discovery-work.test-fixture'

const key = (i: number) => `tab-${i}:11111111-1111-4111-8111-${String(i).padStart(12, '0')}`

it.each([10, 100])(
  'seeks only the affected owner ranges against %i unrelated eligible Run/Dispatch mailboxes',
  (n) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const relevant = Array.from({ length: 3 }, (_, i) => {
        const run = db.createRun({
          objective: 'old but current',
          coordinatorHandle: `term_${i}`,
          coordinatorPaneKey: key(i),
          coordinatorOrcaSessionId: parseOrcaSessionAddress(`orca_session_id:session-${i}`)
        })
        db.createRun({
          objective: 'newer current, empty',
          coordinatorHandle: `term_${i}`,
          coordinatorPaneKey: key(i),
          coordinatorOrcaSessionId: parseOrcaSessionAddress(`orca_session_id:session-${i}`)
        })
        const task = db.createTask({ spec: 'worker', runId: run.id })
        const dispatch = createRootDispatch(db, task.id, `term_${i}`, key(i))
        db.db
          .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
          .run(`session-${i}`, dispatch.id)
        const shadowTask = db.createTask({ spec: 'shadowed attachment', runId: run.id })
        const shadow = createRootDispatch(db, shadowTask.id, `term_shadow_${i}`, key(50 + i))
        db.completeDispatch(shadow.id)
        for (const [id, state] of [
          [`remote-${i}`, 'ready'],
          [shadow.id, 'ready'],
          [`ended-${i}`, 'succeeded']
        ]) {
          db.db
            .prepare(`INSERT INTO remote_dispatch_attachments
          (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, pane_key, state, terminal_handle)
          VALUES (?, ?, 'peer', 'epoch', ?, ?, ?)`)
            .run(id, task.id, key(i), state, `term_${i}`)
        }
        const mailboxes = [`run:${run.id}`, `dispatch:${dispatch.id}`, `dispatch:remote-${i}`]
        const messages = mailboxes.map((to) =>
          db.insertMessage({ runId: run.id, from: 'worker', to, subject: 'eligible' })
        )
        for (const to of [`dispatch:${shadow.id}`, `dispatch:ended-${i}`]) {
          db.insertMessage({
            runId: run.id,
            from: 'worker',
            to,
            subject: 'not owned by this live pane'
          })
        }
        return { run, dispatch, mailboxes, messages }
      })
      for (let i = 0; i < n; i++) {
        const run = db.createRun({
          objective: 'unrelated',
          coordinatorHandle: `term_unrelated_${i}`,
          coordinatorPaneKey: key(1000 + i)
        })
        const task = db.createTask({ spec: 'unrelated', runId: run.id })
        const dispatch = createRootDispatch(db, task.id, `term_unrelated_${i}`, key(1000 + i))
        for (const to of [`run:${run.id}`, `dispatch:${dispatch.id}`]) {
          db.insertMessage({ runId: run.id, from: 'worker', to, subject: 'unrelated eligible' })
        }
      }
      db.db.exec('ANALYZE')
      const work = countDiscoveryRows(db)
      for (const k of [1, 3]) {
        work.clear()
        const visited = new Set<string>()
        const found = Array.from({ length: k }, (_, i) =>
          sleepingMailOwnerMailboxes(db, key(i), visited)
        ).flat()
        expect(found).toEqual(relevant.slice(0, k).flatMap((owner) => owner.mailboxes))
        expect(work.owners).toHaveLength(5 * k)
        expect(work.probes).toHaveLength(4 * k)
        expect(work.messages).toHaveLength(3 * k)
        expect(
          work.plans.filter((detail) => /SCAN (?!CONSTANT ROW)|MATERIALIZE/.test(detail))
        ).toEqual([])
        for (const index of [
          'idx_runs_coordinator_pane_leaf',
          'idx_dispatch_assignee_pane_leaf',
          'idx_remote_dispatch_attachments_active_pane_suffix'
        ]) {
          expect(
            work.plans.some((detail) => detail.includes(`USING INDEX ${index} (<expr>=?)`))
          ).toBe(true)
        }
        expect(
          work.plans.some((detail) =>
            /SEARCH messages USING (?:COVERING )?INDEX idx_messages_mail_wake_candidate \(to_handle=\?\)/.test(
              detail
            )
          )
        ).toBe(true)
        console.info(
          'owner-range-proof',
          JSON.stringify({
            unrelatedEligible: 2 * n,
            k,
            ownerRows: work.owners.length,
            probes: work.probes.length,
            messageRows: work.messages.length,
            plans: [...new Set(work.plans)]
          })
        )
      }
      work.stop()
      const first = relevant[0]!
      const select = (
        waiters?: Set<{ typeFilter: string[] | undefined }>,
        reservedTypes?: Set<string>
      ) =>
        selectOrchestrationPointerSequence({
          db,
          mailboxHandle: first.mailboxes[0]!,
          waiters,
          reservedTypes
        })
      expect(select()).toBe(first.messages[0]!.sequence)
      expect(select(new Set([{ typeFilter: undefined }]))).toBeUndefined()
      expect(select(new Set([{ typeFilter: ['status'] }]))).toBeUndefined()
      expect(select(undefined, new Set(['status']))).toBeUndefined()
      expect(
        db.getOrCreateRunDelivery({
          runId: first.run.id,
          consumerGeneration: first.run.consumer_generation
        })
      ).toBeDefined()
      expect(select()).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
      db.close()
    }
  }
)
