import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { messageFixture } from './journal-sql-message.test-fixture'
import { applyJournalSqlMaintenance, type JournalSqlMaintenance } from './journal-sql-maintenance'
import { readJournalSqlDatabase } from './journal-sql-database-read'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import { JournalSqlActivity } from './journal-sql-activity'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'

const databases: Database.Database[] = []
const maintainers: JournalSqlBackgroundMaintenance[] = []
afterEach(async () => {
  for (const maintenance of maintainers.splice(0)) {
    maintenance.stop()
    await maintenance.settled()
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  db.pragma('auto_vacuum=INCREMENTAL')
  messageFixture(db)
  return db
}

function maintain(db: Database.Database, operation: JournalSqlMaintenance) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = applyJournalSqlMaintenance(db, operation)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

it('prunes proven retired epochs with atomic rollback while preserving incomplete imports and current anchors', () => {
  const db = fixture()
  for (const [sessionId, epoch] of [
    ['chat', 'before'],
    ['chat', 'later'],
    ['chat', 'epoch'],
    ['incomplete', 'epoch'],
    ['failed', 'epoch']
  ]) {
    const prefix = [sessionId, epoch]
    db.prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,sequence,
      sequence_index,owner_fence,payload_json) VALUES(?,?,'body',1,1,1,0,1,'{"text":"saved body"}')`).run(
      ...prefix
    )
    db.prepare(`INSERT INTO journal_item_tombstones VALUES(?,?,'deleted',1)`).run(...prefix)
    db.prepare(`INSERT INTO journal_item_subagent_names
      VALUES(?,?,'agent','body',1,0,1,0)`).run(...prefix)
    db.prepare(`INSERT INTO journal_item_aliases VALUES(?,?,'provider','body',0,NULL)`).run(
      ...prefix
    )
    db.prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,
      attempt_index,current,item_id,ordinal,submitted_at,fingerprint,dispatch_state,payload_json)
      VALUES(?,?,'send',1,0,1,'body',1,1,'fingerprint','accepted','accepted body')`).run(...prefix)
    db.prepare(
      `INSERT INTO journal_send_receipts(session_id,epoch,message_id,payload_json) VALUES(?,?,'send','accepted receipt')`
    ).run(...prefix)
    db.prepare(`INSERT INTO journal_settlements VALUES(?,?,'settlement')`).run(...prefix)
    db.prepare(
      `INSERT INTO journal_queue_cards VALUES(?,?,'queued',1,'waiting',1,NULL,'domain body')`
    ).run(...prefix)
    db.prepare(
      `INSERT INTO journal_edit_leases VALUES(?,?,'owner','caller','edit','queued',1,100)`
    ).run(...prefix)
    db.prepare(`INSERT INTO journal_provider_activity VALUES(?,?,1,100)`).run(...prefix)
    db.prepare(`INSERT INTO journal_events VALUES(?,?,1,100,'{}')`).run(...prefix)
  }
  db.exec(`INSERT INTO agent_session_records VALUES('chat','saved record');
    INSERT INTO agent_session_tabs VALUES('tab','chat',1)`)
  db.exec('BEGIN IMMEDIATE')
  applyJournalSqlMaintenance(db, {
    kind: 'domain-retired-prune',
    sessionId: 'chat',
    epoch: 'epoch'
  })
  applyJournalSqlMaintenance(db, { kind: 'compaction-complete', now: 200 })
  db.exec('ROLLBACK')
  expect(
    db
      .prepare("SELECT payload_json FROM journal_items WHERE session_id='chat' AND epoch='before'")
      .get()
  ).toEqual({ payload_json: '{"text":"saved body"}' })
  expect(maintain(db, { kind: 'compaction-state' })).toEqual({
    kind: 'compaction-state',
    completedAt: null
  })
  let more = true
  while (more) {
    const result = maintain(db, { kind: 'domain-retired-prune', sessionId: 'chat', epoch: 'epoch' })
    if (!result || typeof result !== 'object' || !('more' in result)) {
      throw new Error('expected page')
    }
    more = result.more
  }
  expect(
    db.prepare('SELECT session_id,epoch,payload_json FROM journal_items ORDER BY session_id').all()
  ).toEqual([
    { session_id: 'chat', epoch: 'epoch', payload_json: '{"text":"saved body"}' },
    { session_id: 'failed', epoch: 'epoch', payload_json: '{"text":"saved body"}' },
    { session_id: 'incomplete', epoch: 'epoch', payload_json: '{"text":"saved body"}' }
  ])
  expect(
    db.prepare("SELECT payload_json FROM journal_send_receipts WHERE session_id='chat'").all()
  ).toEqual([{ payload_json: 'accepted receipt' }])
  expect(
    db
      .prepare('SELECT session_id,epoch,settlement_id FROM journal_settlements ORDER BY session_id')
      .all()
  ).toEqual([
    { session_id: 'chat', epoch: 'epoch', settlement_id: 'settlement' },
    { session_id: 'failed', epoch: 'epoch', settlement_id: 'settlement' },
    { session_id: 'incomplete', epoch: 'epoch', settlement_id: 'settlement' }
  ])
  expect(
    db
      .prepare(
        "SELECT epoch,subagent_id,item_id FROM journal_item_subagent_names WHERE session_id='chat'"
      )
      .all()
  ).toEqual([{ epoch: 'epoch', subagent_id: 'agent', item_id: 'body' }])
  expect(
    db.prepare("SELECT payload_json FROM journal_submission_attempts WHERE session_id='chat'").all()
  ).toEqual([{ payload_json: 'accepted body' }])
  expect(db.prepare('SELECT record_json FROM agent_session_records').get()).toEqual({
    record_json: 'saved record'
  })
  expect(db.prepare('SELECT tab_id,session_id,position FROM agent_session_tabs').get()).toEqual({
    tab_id: 'tab',
    session_id: 'chat',
    position: 1
  })
  maintain(db, { kind: 'compaction-complete', now: 200 })
  expect(maintain(db, { kind: 'compaction-state' })).toEqual({
    kind: 'compaction-state',
    completedAt: 200
  })
})

it('returns a free page inside the writer transaction and restores it on rollback', () => {
  const db = fixture()
  db.exec(`CREATE TABLE reclaim_fixture(payload BLOB);
    INSERT INTO reclaim_fixture VALUES(zeroblob(65536));
    DELETE FROM reclaim_fixture`)
  const pages = () => Number(db.pragma('page_count', { simple: true }))
  const before = pages()
  db.exec('BEGIN IMMEDIATE')
  applyJournalSqlMaintenance(db, { kind: 'page-reclaim' })
  expect(pages()).toBeLessThan(before)
  db.exec('ROLLBACK')
  expect(pages()).toBe(before)
  maintain(db, { kind: 'page-reclaim' })
  expect(pages()).toBeLessThan(before)
})

it('bounds a ready-head pass at its captured high key and skips changed or removed heads', () => {
  const db = fixture()
  const insert =
    db.prepare(`INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
    VALUES('workspace',?,'epoch',0,0)`)
  for (let index = 0; index < 20; index++) {
    insert.run(`session-${String(index).padStart(2, '0')}`)
  }
  db.exec(`INSERT INTO journal_item_tombstones VALUES('chat','before','old',1),
    ('chat','epoch','current',1),('session-00','before','old',1)`)
  const page = readJournalSqlDatabase(db, { kind: 'retired-heads', after: null, through: null })
  expect(page).toMatchObject({ kind: 'retired-heads', through: 'session-19' })
  if (page.kind !== 'retired-heads') {
    throw new Error('expected ready heads')
  }
  expect(page.heads.map((head) => head.sessionId)).toEqual([
    'chat',
    'session-00',
    'session-01',
    'session-02',
    'session-03',
    'session-04',
    'session-05',
    'session-06',
    'session-07',
    'session-08',
    'session-09',
    'session-10',
    'session-11',
    'session-12',
    'session-13',
    'session-14'
  ])
  expect(db.isTransaction).toBe(false)
  insert.run('session-20')
  db.exec(`UPDATE journal_chat_state SET epoch='replacement' WHERE session_id='chat';
    DELETE FROM journal_chat_state WHERE session_id IN ('session-00','session-19')`)
  for (const target of page.heads.slice(0, 2)) {
    expect(maintain(db, { kind: 'domain-retired-prune', ...target })).toEqual({
      kind: 'domain-retired',
      deleted: 0,
      more: false
    })
  }
  expect(
    db
      .prepare('SELECT session_id,epoch FROM journal_item_tombstones ORDER BY session_id,epoch')
      .all()
  ).toEqual([
    { session_id: 'chat', epoch: 'before' },
    { session_id: 'chat', epoch: 'epoch' },
    { session_id: 'session-00', epoch: 'before' }
  ])
  expect(
    readJournalSqlDatabase(db, {
      kind: 'retired-heads',
      after: 'session-14',
      through: page.through
    })
  ).toEqual({
    kind: 'retired-heads',
    through: 'session-19',
    heads: [
      { sessionId: 'session-15', epoch: 'epoch' },
      { sessionId: 'session-16', epoch: 'epoch' },
      { sessionId: 'session-17', epoch: 'epoch' },
      { sessionId: 'session-18', epoch: 'epoch' }
    ]
  })
  expect(
    readJournalSqlDatabase(db, {
      kind: 'retired-heads',
      after: 'session-18',
      through: page.through
    })
  ).toEqual({ kind: 'retired-heads', through: 'session-19', heads: [] })
  expect(
    readJournalSqlDatabase(db, { kind: 'retired-heads', after: null, through: null })
  ).toMatchObject({ kind: 'retired-heads', through: 'session-20' })
})

it.each([100, 1_000])(
  'seeks one selected chat around %i current rows and unrelated heads without scanning them',
  (size) => {
    const db = fixture()
    db.exec('BEGIN IMMEDIATE')
    const head =
      db.prepare(`INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
      VALUES('workspace',?,'epoch',0,0)`)
    const current = db.prepare(`INSERT INTO journal_item_tombstones VALUES(?,'epoch',?,1)`)
    for (let index = 0; index < size; index++) {
      const sessionId = `profile-${index}`
      head.run(sessionId)
      current.run(sessionId, 'current')
      current.run('chat', `current-${index}`)
    }
    db.exec(`INSERT INTO journal_item_tombstones VALUES('profile-0','before','keep-other-chat',1)`)
    const retired = db.prepare(`INSERT INTO journal_item_tombstones VALUES('chat',?,?,1)`)
    for (let index = 0; index < 25; index++) {
      retired.run('before', `old-${index}`)
      retired.run('later', `old-${index}`)
    }
    db.exec(`INSERT INTO journal_item_subagent_names VALUES
      ('chat','before','agent-a','old',1,0,1,0),('chat','later','agent-b','old',1,0,1,0),
      ('chat','later','agent-c','old',1,0,1,0);
      INSERT INTO journal_events VALUES('chat','later',1,1,'{}')`)
    db.exec('COMMIT')

    const prepare = db.prepare.bind(db)
    const queries = new Map<string, SqliteBindings>()
    const instrumented = new WeakSet<Database.Statement>()
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (!instrumented.has(statement)) {
        instrumented.add(statement)
        const run = statement.run.bind(statement)
        vi.spyOn(statement, 'run').mockImplementation((...parameters: SqliteBindings) => {
          queries.set(sql, parameters)
          return run(...parameters)
        })
        const get = statement.get.bind(statement)
        vi.spyOn(statement, 'get').mockImplementation((...parameters: SqliteBindings) => {
          queries.set(sql, parameters)
          return get(...parameters)
        })
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...parameters: SqliteBindings) => {
          queries.set(sql, parameters)
          return all(...parameters)
        })
      }
      return statement
    })
    expect(
      maintain(db, { kind: 'domain-retired-prune', sessionId: 'chat', epoch: 'epoch' })
    ).toEqual({ kind: 'domain-retired', deleted: 50, more: true })
    expect(
      maintain(db, { kind: 'domain-retired-prune', sessionId: 'chat', epoch: 'epoch' })
    ).toEqual({ kind: 'domain-retired', deleted: 4, more: false })
    vi.restoreAllMocks()

    // Query plans establish the range contract independently of how many heads were seeded.
    const plans = [...queries].flatMap(([sql, parameters]) =>
      prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...parameters)
        .map((row) => String(row.detail))
    )
    expect(plans).toContain(
      'SEARCH journal_chat_state USING INDEX sqlite_autoindex_journal_chat_state_1 (session_id=?)'
    )
    expect(plans.some((detail) => /^SCAN (journal_|ready|retired)/.test(detail))).toBe(false)
    expect(
      plans
        .filter((detail) => detail.startsWith('SEARCH '))
        .every(
          (detail) =>
            detail.startsWith('SEARCH journal_chat_state ') ||
            /\(session_id=\? AND epoch[<>=]\?/.test(detail)
        )
    ).toBe(true)
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM journal_item_tombstones WHERE session_id='chat' AND epoch='epoch'"
        )
        .get()
    ).toEqual({ count: size })
    expect(
      db
        .prepare(
          "SELECT epoch,item_id FROM journal_item_tombstones WHERE session_id='profile-0' ORDER BY epoch"
        )
        .all()
    ).toEqual([
      { epoch: 'before', item_id: 'keep-other-chat' },
      { epoch: 'epoch', item_id: 'current' }
    ])
    expect(
      db.prepare("SELECT epoch FROM journal_item_subagent_names WHERE session_id='chat'").all()
    ).toEqual([])
  }
)

it('packs retired payload bytes across tables and lets one oversized row progress alone', () => {
  const db = fixture()
  const insert = db.prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,
    sequence,sequence_index,owner_fence,payload_json) VALUES('chat','before',?,1,1,1,0,1,?)`)
  insert.run('first', JSON.stringify({ text: 'α'.repeat(150 * 1024) }))
  insert.run('second', JSON.stringify({ text: 'α'.repeat(150 * 1024) }))
  db.prepare(`UPDATE journal_items SET original_stop_note_json=?
    WHERE item_id='second'`).run('x'.repeat(600 * 1024))
  const receipt = db.prepare(
    `INSERT INTO journal_send_receipts(session_id,epoch,message_id,payload_json) VALUES('chat','before',?,?)`
  )
  receipt.run('first', JSON.stringify({ text: 'x'.repeat(600 * 1024) }))
  receipt.run('oversized', JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }))
  const prune = () =>
    maintain(db, { kind: 'domain-retired-prune', sessionId: 'chat', epoch: 'epoch' })
  expect(prune()).toEqual({ kind: 'domain-retired', deleted: 1, more: true })
  expect(db.prepare('SELECT item_id FROM journal_items').all()).toEqual([{ item_id: 'second' }])
  expect(prune()).toEqual({ kind: 'domain-retired', deleted: 1, more: true })
  expect(db.prepare('SELECT item_id FROM journal_items').all()).toEqual([])
  expect(
    db.prepare('SELECT message_id FROM journal_send_receipts ORDER BY message_id').all()
  ).toEqual([{ message_id: 'first' }, { message_id: 'oversized' }])
  expect(prune()).toEqual({ kind: 'domain-retired', deleted: 1, more: true })
  expect(db.prepare('SELECT message_id FROM journal_send_receipts').all()).toEqual([
    { message_id: 'oversized' }
  ])
  expect(prune()).toEqual({ kind: 'domain-retired', deleted: 1, more: true })
  expect(db.prepare('SELECT message_id FROM journal_send_receipts').all()).toEqual([])
  expect(prune()).toEqual({ kind: 'domain-retired', deleted: 0, more: false })
})

it('finishes a retired pass during activity while an already-started conversion is paused on idle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(100)
  const db = fixture()
  const activity = new JournalSqlActivity()
  const paused = Promise.withResolvers<void>()
  const passFinished = Promise.withResolvers<void>()
  let converted = false
  let awaitingPass = false
  const errors: unknown[] = []
  const maintenance = new JournalSqlBackgroundMaintenance(
    { maintain: async (operation) => maintain(db, operation) },
    {
      database: async (operation) => {
        if (operation.kind === 'sessions') {
          return { kind: 'sessions', sessionIds: operation.after === null ? ['unready'] : [] }
        }
        const result = readJournalSqlDatabase(db, operation)
        if (awaitingPass && result.kind === 'retired-heads' && result.heads.length === 0) {
          passFinished.resolve()
        }
        return result
      }
    },
    {
      ensure: async (_sessionId, foreground) => {
        if (foreground) {
          throw new Error('background conversion was promoted')
        }
        activity.setSessionActive('streaming', true)
        paused.resolve()
        await activity.waitForIdle(new AbortController().signal)
        converted = true
        return null
      }
    },
    activity,
    (error) => errors.push(error)
  )
  maintainers.push(maintenance)
  const started = maintenance.start()
  await paused.promise
  db.exec('BEGIN IMMEDIATE')
  const head =
    db.prepare(`INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
    VALUES('workspace',?,'epoch',0,0)`)
  const retired = db.prepare(`INSERT INTO journal_item_tombstones VALUES(?,'before',?,1)`)
  for (let chat = 0; chat < 20; chat++) {
    const sessionId = `retired-${String(chat).padStart(2, '0')}`
    head.run(sessionId)
    for (let row = 0; row < 53; row++) {
      retired.run(sessionId, `old-${row}`)
    }
    db.prepare(`INSERT INTO journal_item_tombstones VALUES(?,'epoch','current',1)`).run(sessionId)
  }
  db.exec('COMMIT')
  awaitingPass = true
  await vi.advanceTimersByTimeAsync(60_000)
  await passFinished.promise
  expect(converted).toBe(false)
  expect(errors).toEqual([])
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM journal_item_tombstones WHERE epoch='before'").get()
  ).toEqual({ count: 0 })
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM journal_item_tombstones WHERE epoch='epoch'").get()
  ).toEqual({ count: 20 })
  activity.setSessionActive('streaming', false)
  await started
  expect(converted).toBe(true)
})
