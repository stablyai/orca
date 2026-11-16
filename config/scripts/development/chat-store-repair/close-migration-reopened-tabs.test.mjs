import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DOMAIN_FILE,
  findMigrationReopenedTabs,
  findRunningOrca,
  LEGACY_FILE
} from './close-migration-reopened-tabs.mjs'

const SCRIPT = path.join(import.meta.dirname, 'close-migration-reopened-tabs.mjs')
const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const copyId = (id) => createHash('sha256').update(`${id}\0rev-${id}`).digest('hex').slice(0, 32)
const tabId = (session) => `structured-agent-session-${session}`

/**
 * The older journal has chats L0..L6 (L0 and L4 open there). Before the faulty pass the store showed
 * L0 and L1, and L1 was converted. The pass then appended, in journal order: a copy of L1 (the user
 * closed it since), L2, a copy of L3 that holds an older build's turn, L4, a copy of L5, and L6, which
 * the user has written in since. A chat N created here sits after them.
 */
function writeProfile() {
  const userData = mkdtempSync(path.join(tmpdir(), 'orca-tab-repair-'))
  roots.push(userData)
  const ids = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']
  const legacy = new DatabaseSync(path.join(userData, LEGACY_FILE))
  legacy.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE agent_session_records(session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
    CREATE TABLE agent_session_tabs(tab_id TEXT PRIMARY KEY, session_id TEXT, position INTEGER);
    CREATE TABLE journal_sessions(session_id TEXT PRIMARY KEY, epoch TEXT, workspace_id TEXT);
    CREATE TABLE journal_rows(session_id TEXT, epoch TEXT, seq INTEGER);`)
  const domain = new DatabaseSync(path.join(userData, DOMAIN_FILE))
  domain.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE agent_session_records(session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
    CREATE TABLE agent_session_tabs(tab_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE agent_session_store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE journal_items(session_id TEXT, item_id TEXT);
    CREATE TABLE journal_item_tombstones(session_id TEXT, item_id TEXT);
    CREATE TABLE journal_chat_state(session_id TEXT PRIMARY KEY, epoch TEXT, last_sequence INTEGER);`)
  for (const id of ids) {
    legacy.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(id, '{}')
    legacy.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run(id, 'e1', 'w')
    legacy
      .prepare('INSERT INTO journal_rows VALUES (?, ?, ?), (?, ?, ?)')
      .run(id, 'e1', 1, id, 'e1', 2)
    domain.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(id, '{}')
    domain
      .prepare('INSERT INTO agent_session_store_meta VALUES (?, ?)')
      .run(`journal.legacy-revision:${id}`, `rev-${id}`)
    domain.prepare('INSERT INTO journal_items VALUES (?, ?)').run(id, `${id}-item`)
  }
  for (const [position, id] of [
    [0, 'L0'],
    [1, 'L4']
  ]) {
    legacy.prepare('INSERT INTO agent_session_tabs VALUES (?, ?, ?)').run(tabId(id), id, position)
  }
  for (const original of ['L1', 'L3', 'L5']) {
    const copy = copyId(original)
    domain
      .prepare('INSERT INTO agent_session_records VALUES (?, ?)')
      .run(copy, JSON.stringify({ conversationName: `copy of ${original}` }))
    domain.prepare('INSERT INTO journal_items VALUES (?, ?)').run(copy, `${original}-item`)
    domain.prepare('INSERT INTO journal_chat_state VALUES (?, ?, ?)').run(copy, 'e1', 2)
  }
  domain.prepare('INSERT INTO journal_items VALUES (?, ?)').run(copyId('L3'), 'older-build-turn')
  domain.prepare('INSERT INTO journal_chat_state VALUES (?, ?, ?)').run('L0', null, 0)
  domain.prepare('INSERT INTO journal_chat_state VALUES (?, ?, ?)').run('L1', 'e1', 2)
  domain.prepare('INSERT INTO journal_chat_state VALUES (?, ?, ?)').run('L6', 'e1', 5)
  domain.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('N', '{}')
  const tabs = ['L0', 'L1', null, 'L2', copyId('L3'), 'L4', copyId('L5'), 'L6', 'N']
  tabs.forEach((session, position) => {
    if (session !== null) {
      domain
        .prepare('INSERT INTO agent_session_tabs VALUES (?, ?, ?)')
        .run(tabId(session), session, position)
    }
  })
  legacy.close()
  domain.close()
  return userData
}

function read(userData, sql) {
  const db = new DatabaseSync(path.join(userData, DOMAIN_FILE), { readOnly: true })
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }))
  } finally {
    db.close()
  }
}

function snapshot(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => lstatSync(path.join(dir, file)).isFile())
      .map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(path.join(dir, file)))
          .digest('hex')
      ])
  )
}

function run(userData, ...args) {
  return spawnSync(process.execPath, [SCRIPT, '--user-data', userData, ...args], {
    encoding: 'utf8'
  })
}

describe('close-migration-reopened-tabs', () => {
  it('selects only untouched tabs the faulty pass opened', () => {
    const userData = writeProfile()
    const legacy = new DatabaseSync(path.join(userData, LEGACY_FILE), { readOnly: true })
    const domain = new DatabaseSync(path.join(userData, DOMAIN_FILE))
    try {
      const found = findMigrationReopenedTabs(legacy, domain)
      // L0 and L1 were open before the pass, L4 was open in the older journal, L6 has new turns,
      // and the copy of L3 holds a turn only an older build saved.
      expect(found.close.map((tab) => tab.session)).toEqual(['L2', copyId('L5')])
      expect(found.kept).toEqual({ writtenSince: 1, openBefore: 3, olderBuildCopy: 1 })
      expect(found.copies.duplicates.map((copy) => copy.original)).toEqual(['L1', 'L5'])
      expect(found.copies.olderBuildTurns).toBe(1)

      // Without a duplicate copy's tab, nothing proves the run came from the faulty pass.
      domain.prepare('DELETE FROM agent_session_tabs WHERE session_id=?').run(copyId('L5'))
      expect(findMigrationReopenedTabs(legacy, domain).close).toEqual([])
    } finally {
      domain.close()
      legacy.close()
    }
  })

  it('dry run changes nothing; apply backs up, closes those tabs, and a rerun is a no-op', () => {
    const userData = writeProfile()
    const before = snapshot(userData)
    const dry = run(userData)
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain('Would close 2 of 8 chat tabs')
    expect(snapshot(userData)).toEqual(before)

    const applied = run(userData, '--apply')
    expect(applied.status).toBe(0)
    const backup = /to (.+-chat-backup-\S+)/.exec(applied.stdout)?.[1]
    expect(backup).toBeDefined()
    roots.push(backup)
    expect(snapshot(backup)).toEqual(before)
    expect(read(userData, 'SELECT session_id FROM agent_session_tabs ORDER BY position')).toEqual(
      ['L0', 'L1', copyId('L3'), 'L4', 'L6', 'N'].map((session_id) => ({ session_id }))
    )
    expect(read(userData, 'SELECT count(*) AS n FROM agent_session_records')).toEqual([{ n: 11 }])

    const rerun = run(userData, '--apply')
    expect(rerun.stdout).toContain('Already repaired')
    expect(read(userData, 'SELECT count(*) AS n FROM agent_session_tabs')).toEqual([{ n: 6 }])
  })

  // Chromium's SingletonLock symlink is how macOS and Linux show a running Orca.
  it.skipIf(process.platform === 'win32')('refuses to apply while Orca holds the profile', () => {
    const userData = writeProfile()
    symlinkSync(`${hostname()}-${process.pid}`, path.join(userData, 'SingletonLock'))
    expect(findRunningOrca(userData, { processName: () => 'Orca' })).toContain(String(process.pid))
    expect(findRunningOrca(userData, { processName: () => 'launchd' })).toBeNull()

    const before = snapshot(userData)
    const refused = run(userData, '--apply')
    expect(refused.status).toBe(1)
    expect(snapshot(userData)).toEqual(before)
    expect(
      readdirSync(path.dirname(userData)).some((name) =>
        name.startsWith(`${path.basename(userData)}-chat-backup-`)
      )
    ).toBe(false)
  })
})
