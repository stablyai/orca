import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { MAILBOX_POINTER_RESERVED } from './mailbox-pointer-enter-state'

const dirs: string[] = []
const dbs: OrchestrationDb[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-pointer-gate-'))
  dirs.push(dir)
  return join(dir, 'orchestration.db')
}

function open(path = databasePath()): OrchestrationDb {
  const db = new OrchestrationDb(path)
  dbs.push(db)
  return db
}

function stagePointer(db: OrchestrationDb, ptyId: string, to: string): string {
  const message = db.insertMessage({
    from: 'term_sender',
    to,
    subject: 'hello',
    type: 'status',
    deliveryContract: 'current_delivery'
  })
  expect(db.stageMailboxPointerEnter([message.id], { ptyId, processIncarnation: 'p1' })).toBe(true)
  return message.id
}

function countStatements(db: OrchestrationDb): { count: number } {
  const counter = { count: 0 }
  const prepare = db.db.prepare.bind(db.db)
  db.db.prepare = (sql: string) => {
    counter.count++
    return prepare(sql)
  }
  return counter
}

// Guards the title-write path: every working/permission title edge released pointers with a sync UPDATE,
// thousands per minute with no mail at all.
describe('mailbox pointer release gate', () => {
  it.each([13, 130])('runs no SQL for %i terminals with no staged pointer', (terminals) => {
    const db = open()
    stagePointer(db, 'pty_other', 'term_other')
    const statements = countStatements(db)
    for (let frame = 0; frame < 20; frame++) {
      for (let i = 0; i < terminals; i++) {
        db.releasePendingMailboxPointerForPty(`pty_${i}`)
      }
    }
    expect(statements.count).toBe(0)
  })

  it('releases a pointer staged before a restart, then stops querying', () => {
    const path = databasePath()
    const first = new OrchestrationDb(path)
    const id = stagePointer(first, 'pty_kept', 'term_kept')
    first.close()

    const restarted = open(path)
    expect(restarted.getMessageById(id)).toMatchObject({
      pointer_enter_pending: MAILBOX_POINTER_RESERVED,
      pointer_pty_id: 'pty_kept'
    })
    const statements = countStatements(restarted)
    restarted.releasePendingMailboxPointerForPty('pty_kept')
    expect(restarted.getMessageById(id)).toMatchObject({
      pointer_enter_pending: 0,
      pointer_pty_id: null,
      delivered_at: null
    })
    const afterRelease = statements.count
    restarted.releasePendingMailboxPointerForPty('pty_kept')
    expect(statements.count).toBe(afterRelease)
  })

  it('releases a pointer staged on a PTY that is reused after release', () => {
    const db = open()
    stagePointer(db, 'pty_reused', 'term_a')
    db.releasePendingMailboxPointerForPty('pty_reused')
    const second = stagePointer(db, 'pty_reused', 'term_b')
    db.releasePendingMailboxPointerForPty('pty_reused')
    expect(db.getMessageById(second)).toMatchObject({
      pointer_enter_pending: 0,
      pointer_pty_id: null
    })
  })
})
