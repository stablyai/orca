import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

describe('admitBotRequest', () => {
  let db: OrchestrationDb
  afterEach(() => db.close())

  const admit = (
    toBotId: string,
    purpose: 'handoff' | 'question' = 'handoff',
    rootKey = 'root',
    sendKey = `${toBotId}:${purpose}:task`
  ) =>
    db.admitBotRequest({
      rootKey,
      sendKey,
      fromBotId: 'ranger',
      toBotId,
      purpose,
      depth: 1,
      record: '{}',
      message: { from: 'orca_session_id:a', to: `orca_session_id:${toBotId}`, subject: 'task' }
    })

  it('stores the mail and request together and suppresses duplicate open sends', () => {
    db = new OrchestrationDb(':memory:')
    const sent = admit('docs')
    expect(sent.kind).toBe('sent')
    const id = sent.kind === 'sent' ? sent.message.id : ''
    expect(db.getMessageById(id)?.to_handle).toBe('orca_session_id:docs')
    expect(db.getBotRequest(id)).toMatchObject({
      root_key: 'root',
      from_bot_id: 'ranger',
      to_bot_id: 'docs',
      purpose: 'handoff',
      depth: 1
    })

    const key = { sendKey: 'docs:handoff:task', purpose: 'handoff' as const }
    expect(db.botRequestBlocked(key)?.kind).toBe('duplicate')
    expect(db.botRequestBlocked({ ...key, sendKey: 'other-send' })).toBeNull()
    expect(admit('docs')).toEqual({ kind: 'duplicate', messageId: id })
    expect(db.getAllMessagesForHandle('orca_session_id:docs')).toHaveLength(1)
    // Any other send to the same bot in the same chain is new mail.
    expect(admit('docs', 'question').kind).toBe('sent')
    expect(admit('docs', 'handoff', 'root', 'docs:handoff:another task').kind).toBe('sent')
    // Once the first has ended, sending it again is new mail too.
    db.recordBotRequestOutcome(id, 'answered')
    expect(admit('docs').kind).toBe('sent')
  })

  it('stores neither when the mail cannot be stored', () => {
    db = new OrchestrationDb(':memory:')
    expect(() =>
      db.admitBotRequest({
        rootKey: 'root',
        fromBotId: null,
        toBotId: 'docs',
        purpose: 'handoff',
        depth: 1,
        record: '{}',
        message: { from: 'a', to: 'b', subject: 'x', runId: 'run_missing' }
      })
    ).toThrow()
    expect(admit('docs').kind).toBe('sent')
  })
})

describe('bot request outcomes', () => {
  let db: OrchestrationDb
  afterEach(() => db.close())

  const admitTo = (toBotId: string) => {
    const sent = db.admitBotRequest({
      rootKey: `root-${toBotId}`,
      sendKey: `${toBotId}-send`,
      fromBotId: 'ranger',
      toBotId,
      purpose: 'handoff',
      depth: 1,
      record: '{}',
      message: { from: 'orca_session_id:a', to: `orca_session_id:${toBotId}`, subject: 'task' }
    })
    return sent.kind === 'sent' ? sent.message.id : ''
  }

  it('keeps the first outcome', () => {
    db = new OrchestrationDb(':memory:')
    const id = admitTo('docs')
    expect(db.getBotRequestOutcome(id)).toBeNull()
    expect(db.recordBotRequestOutcome(id, 'posted')).toBe(true)
    expect(db.recordBotRequestOutcome(id, 'answered')).toBe(false)
    expect(db.getBotRequestOutcome(id)).toBe('posted')
  })

  it('lists a bot’s requests no one has read and that have no outcome', () => {
    db = new OrchestrationDb(':memory:')
    const unread = admitTo('docs')
    const read = admitTo('docs-2')
    db.markAsRead([read])
    const settled = db.admitBotRequest({
      rootKey: 'other',
      fromBotId: null,
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: { from: 'x', to: 'orca_session_id:docs', subject: 'q' }
    })
    db.recordBotRequestOutcome(settled.kind === 'sent' ? settled.message.id : '', 'dropped')
    expect(db.listUnreadBotRequests('docs').map(({ message }) => message.id)).toEqual([unread])
    expect(db.listUnreadBotRequests('docs-2')).toEqual([])
  })
})

describe('a bot_requests table made before status', () => {
  it('is rebuilt by the v48 migration, keeping its rows, and then takes status', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-bot-requests-status-'))
    const path = join(directory, 'orchestration.db')
    try {
      const before = new OrchestrationDb(path)
      before.db.exec(`
        DROP TABLE bot_requests;
        CREATE TABLE bot_requests (
          message_id  TEXT PRIMARY KEY,
          root_key    TEXT NOT NULL,
          from_bot_id TEXT,
          to_bot_id   TEXT NOT NULL,
          purpose     TEXT NOT NULL CHECK(purpose IN ('handoff', 'question')),
          depth       INTEGER NOT NULL,
          record      TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO bot_requests (message_id, root_key, from_bot_id, to_bot_id, purpose, depth, record, created_at)
          VALUES ('msg_old', 'root', 'ranger', 'docs', 'handoff', 1, '{"old":true}', '2026-11-01 10:00:00');
        PRAGMA user_version = 46;
      `)
      before.close()

      const after = new OrchestrationDb(path)
      try {
        expect(after.getBotRequest('msg_old')).toEqual({
          message_id: 'msg_old',
          root_key: 'root',
          from_bot_id: 'ranger',
          to_bot_id: 'docs',
          purpose: 'handoff',
          depth: 1,
          record: '{"old":true}',
          created_at: '2026-11-01 10:00:00',
          send_key: null
        })
        const status = after.admitBotRequest({
          rootKey: 'root',
          fromBotId: 'ranger',
          toBotId: 'docs',
          purpose: 'status',
          depth: 1,
          record: '{}',
          message: { from: 'a', to: 'b', subject: 'fyi', type: 'status' }
        })
        expect(status.kind).toBe('sent')
        // A new handoff to a bot the old request reached is new mail, not held by the old index.
        const handoff = {
          rootKey: 'root',
          sendKey: 'root:docs:handoff:new',
          fromBotId: 'ranger',
          toBotId: 'docs',
          purpose: 'handoff' as const,
          depth: 2,
          record: '{}',
          message: { from: 'a', to: 'b', subject: 'new', type: 'handoff' as const }
        }
        expect(after.admitBotRequest(handoff).kind).toBe('sent')
        expect(after.admitBotRequest(handoff).kind).toBe('duplicate')
      } finally {
        after.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
