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
// thousands per minute with no mail at all. Now each PTY runs it once per session, never per frame.
describe('mailbox pointer release gate', () => {
  it.each([13, 130])(
    'runs one release per terminal, not per frame, for %i terminals',
    (terminals) => {
      const db = open()
      const statements = countStatements(db)
      for (let frame = 0; frame < 20; frame++) {
        for (let i = 0; i < terminals; i++) {
          db.releasePendingMailboxPointerForPty(`pty_${i}`)
        }
      }
      expect(statements.count).toBe(terminals)
    }
  )

  it('releases a pointer staged before a restart on the first working edge', () => {
    const path = databasePath()
    const first = new OrchestrationDb(path)
    first.releasePendingMailboxPointerForPty('pty_kept')
    const id = stagePointer(first, 'pty_kept', 'term_kept')
    first.close()

    const restarted = open(path)
    expect(restarted.getMessageById(id)).toMatchObject({
      pointer_enter_pending: MAILBOX_POINTER_RESERVED,
      pointer_pty_id: 'pty_kept'
    })
    restarted.releasePendingMailboxPointerForPty('pty_kept')
    expect(restarted.getMessageById(id)).toMatchObject({
      pointer_enter_pending: 0,
      pointer_pty_id: null,
      delivered_at: null
    })
  })

  it('releases an Enter-attempted pointer left on an id that cold restore reuses after exit', () => {
    const db = open()
    db.releasePendingMailboxPointerForPty('pty_restored')
    const id = stagePointer(db, 'pty_restored', 'term_c')
    const target = { ptyId: 'pty_restored', processIncarnation: 'p1' }
    expect(db.markMailboxPointerWriteAttempted([id], target)).toBe(true)
    expect(db.markMailboxPointerEnterAttempted([id], target)).toBe(true)
    db.forgetReleasedPointerPty('pty_restored')
    db.releasePendingMailboxPointerForPty('pty_restored')
    expect(db.getMessageById(id)).toMatchObject({ pointer_enter_pending: 0, pointer_pty_id: null })
    expect(db.getMessageById(id)?.delivered_at).not.toBeNull()
  })
})
