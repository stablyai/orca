import { expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { reconcileSleepingMail } from './sleeping-mail-owner-mailboxes'
import { SleptMailboxWake } from './slept-mailbox-wake'

const sleeper = (index: number, worktreeId: string): SleepingAgentSessionRecord => ({
  paneKey: `tab:${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
  tabId: 'tab',
  worktreeId,
  agent: 'codex',
  providerSession: { key: 'session_id', id: `conversation-${index}` },
  prompt: '',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1,
  restoreOnTabOpenOnly: true
})

it.each([100, 1_000])(
  'a pane joining or leaving an already-held workspace leaves the held set unpublished (%i held)',
  (held) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const records = new Map<string, SleepingAgentSessionRecord>()
      const owe = (record: SleepingAgentSessionRecord) => {
        records.set(record.paneKey, record)
        const run = db.createRun({
          objective: record.paneKey,
          coordinatorHandle: null,
          coordinatorPaneKey: record.paneKey
        })
        db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'owed' })
      }
      for (let index = 0; index < held; index += 1) {
        owe(sleeper(index, `folder:${index}`))
      }
      const delivery = new SleptMailboxWake({
        db: () => db,
        record: (paneKey) => records.get(paneKey) ?? null,
        waiters: () => undefined,
        prepare: async () => {},
        wake: async () => false
      })
      reconcileSleepingMail(delivery, db, records.keys())
      expect(delivery.heldWorktrees()).toHaveLength(held)
      const version = delivery.heldVersion

      const joining = sleeper(held, 'folder:0')
      owe(joining)
      reconcileSleepingMail(delivery, db, [joining.paneKey])
      expect(delivery.heldVersion).toBe(version)
      records.delete(joining.paneKey)
      delivery.refreshPane(joining.paneKey)
      expect(delivery.heldVersion).toBe(version)

      const first = sleeper(held + 1, 'folder:new')
      owe(first)
      reconcileSleepingMail(delivery, db, [first.paneKey])
      expect(delivery.heldVersion).toBe(version + 1)
      expect(delivery.heldWorktrees()).toHaveLength(held + 1)
    } finally {
      db.close()
    }
  }
)
