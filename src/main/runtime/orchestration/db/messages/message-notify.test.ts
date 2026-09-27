import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'
import { selectOrchestrationPointerBatch } from '../../mailbox-pointer-eligibility'

it('keeps silent mail readable but out of automatic batches after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-notify-'))
  let db = new OrchestrationDb(join(dir, 'mail.db'))
  try {
    const silent = db.insertMessage({ from: 'a', to: 'b', subject: 'external', notify: false })
    const normal = db.insertMessage({ from: 'a', to: 'b', subject: 'native' })
    expect(silent).toMatchObject({ notify: 0, read: 0, delivered_at: null })
    expect(normal.notify).toBe(1)
    db.close()
    db = new OrchestrationDb(join(dir, 'mail.db'))
    expect(db.getUndeliveredUnreadMessages('b').map((m) => m.id)).toEqual([normal.id])
    expect(db.getUnreadMessages('b').map((m) => m.id)).toEqual([silent.id, normal.id])
    expect(db.getMessageById(silent.id)).toMatchObject({ notify: 0, read: 0, delivered_at: null })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const version of [42, 43]) {
  it(`upgrades pre-notify rows and repairs a missing column at version ${version}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-notify-upgrade-'))
    const path = join(dir, 'mail.db')
    let db = new OrchestrationDb(path)
    try {
      const old = db.insertMessage({ from: 'a', to: 'b', subject: 'old' })
      db.db.exec('ALTER TABLE messages DROP COLUMN notify')
      db.db.pragma(`user_version = ${version}`)
      db.close()
      db = new OrchestrationDb(path)
      expect(db.getMessageById(old.id)?.notify).toBe(1)
      expect(db.getUndeliveredUnreadMessages('b').map((m) => m.id)).toEqual([old.id])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

it('keeps the policy when direct mail moves to a Run mailbox', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'routing',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const mailbox = `run:${run.id}`
    const silent = db.insertMessage({
      runId: run.id,
      from: 'a',
      to: 'b',
      subject: 'external',
      notify: false
    })
    const normal = db.insertMessage({ runId: run.id, from: 'a', to: 'b', subject: 'native' })
    db.routeDirectMessagePage(mailbox, run.id, 'b')
    expect(
      selectOrchestrationPointerBatch({
        db,
        mailboxHandle: mailbox,
        waiters: undefined,
        reservedTypes: undefined
      }).map((m) => m.id)
    ).toEqual([normal.id])
    expect(db.getUnreadMessages(mailbox).map((m) => m.id)).toEqual([silent.id, normal.id])
  } finally {
    db.close()
  }
})
