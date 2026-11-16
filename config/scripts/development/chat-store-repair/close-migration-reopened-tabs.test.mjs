import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
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
 * The older journal has chats L0..L7 (L4 open there). Before the faulty pass the store showed L0,
 * never viewed here, and L1, converted. The pass then appended, in journal order: a copy of L1 (the user
 * closed it since), L2, a copy of L3 holding a reply only an older build saved, L4, a copy of L5,
 * L6, which the user has written in since, and L7, which the user closed and reopened on a paired
 * device. A chat N created here sits between the last two.
 */
function writeProfile() {
  const userData = mkdtempSync(path.join(tmpdir(), 'orca-tab-repair-'))
  roots.push(userData)
  const ids = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']
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
    CREATE TABLE journal_items(session_id TEXT, item_id TEXT, revision INTEGER, payload_json TEXT);
    CREATE TABLE journal_item_tombstones(session_id TEXT, item_id TEXT, revision INTEGER);
    CREATE TABLE journal_chat_state(session_id TEXT PRIMARY KEY, epoch TEXT, last_sequence INTEGER);`)
  const insert = (db, table, ...values) =>
    db.prepare(`INSERT INTO ${table} VALUES (${values.map(() => '?').join(',')})`).run(...values)
  for (const id of ids) {
    insert(legacy, 'agent_session_records', id, '{}')
    insert(legacy, 'journal_sessions', id, 'e1', 'w')
    insert(legacy, 'journal_rows', id, 'e1', 1)
    insert(legacy, 'journal_rows', id, 'e1', 2)
    insert(domain, 'agent_session_records', id, '{}')
    insert(domain, 'agent_session_store_meta', `journal.legacy-revision:${id}`, `rev-${id}`)
    insert(domain, 'journal_items', id, `${id}-item`, 1, 'reply')
  }
  insert(legacy, 'agent_session_tabs', tabId('L4'), 'L4', 0)
  for (const original of ['L1', 'L3', 'L5']) {
    const copy = copyId(original)
    insert(domain, 'agent_session_records', copy, JSON.stringify({ conversationName: original }))
    insert(
      domain,
      'journal_items',
      copy,
      `${original}-item`,
      1,
      original === 'L3' ? 'other' : 'reply'
    )
    insert(domain, 'journal_chat_state', copy, 'e1', 2)
    insert(domain, 'journal_chat_state', original, 'e1', 2)
  }
  insert(domain, 'journal_chat_state', 'L0', null, 0)
  insert(domain, 'journal_chat_state', 'L6', 'e1', 5)
  insert(domain, 'agent_session_records', 'N', '{}')
  const tabs = ['L0', 'L1', null, 'L2', copyId('L3'), 'L4', copyId('L5'), 'L6', 'N']
  tabs.forEach((session, position) => {
    if (session !== null) {
      insert(domain, 'agent_session_tabs', tabId(session), session, position)
    }
  })
  insert(domain, 'agent_session_tabs', `agent-chat-tab-v1-${'0'.repeat(8)}`, 'L7', tabs.length)
  legacy.close()
  domain.close()
  return userData
}

function select(userData, change = () => {}) {
  const legacy = new DatabaseSync(path.join(userData, LEGACY_FILE), { readOnly: true })
  const domain = new DatabaseSync(path.join(userData, DOMAIN_FILE))
  try {
    change(domain)
    return findMigrationReopenedTabs(legacy, domain)
  } finally {
    domain.close()
    legacy.close()
  }
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
    const found = select(userData)
    // L0 and L1 were open before the pass (L1's copy proves it, and L0 sits below it), L4 was open
    // in the older journal, L6 has new turns, N was made here, L7's tab is the user's, and the copy
    // of L3 holds a reply only an older build saved.
    expect(found.close.map((tab) => tab.session)).toEqual(['L2', copyId('L5')])
    expect(found.kept).toEqual({
      writtenSince: 0,
      openBefore: 1,
      olderBuildCopy: 1,
      notFromJournal: 0
    })
    expect(found.leftOpen).toBe(0)
    expect(found.copies.duplicates.map((copy) => copy.original)).toEqual(['L1', 'L5'])
    expect(found.copies.olderBuildTurns).toBe(1)

    // A later revision of the item can't show which branch the copy grew from, so it isn't a
    // duplicate; without a duplicate copy's tab, nothing proves the tabs came from the faulty pass.
    const revised = select(userData, (domain) =>
      domain.prepare('UPDATE journal_items SET revision=2 WHERE session_id=?').run('L5')
    )
    expect(revised.close).toEqual([])

    const unproven = select(userData, (domain) =>
      domain.prepare('DELETE FROM agent_session_tabs WHERE session_id=?').run(copyId('L5'))
    )
    expect(unproven.close).toEqual([])
  })

  it('keeps a tab the user reopened on this desktop after the update', () => {
    // Reopening from history here reuses the derived tab id, right after the pass's last tab.
    const found = select(writeProfile(), (domain) => {
      domain.prepare('DELETE FROM agent_session_tabs WHERE session_id IN (?, ?)').run('N', 'L7')
      domain.prepare('INSERT INTO agent_session_tabs VALUES (?, ?, ?)').run(tabId('L7'), 'L7', 8)
    })
    expect(found.close.map((tab) => tab.session)).toEqual(['L2', copyId('L5')])
    expect(found.leftOpen).toBe(1)
  })

  it('dry run changes nothing; apply backs up, closes those tabs, and a rerun is a no-op', () => {
    const userData = writeProfile()
    const before = snapshot(userData)
    const dry = run(userData)
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain('Would close 2 of 9 chat tabs')
    expect(snapshot(userData)).toEqual(before)

    const applied = run(userData, '--apply')
    expect(applied.status).toBe(0)
    const backup = /to (.+-chat-backup-\S+)/.exec(applied.stdout)?.[1]
    expect(backup).toBeDefined()
    roots.push(backup)
    expect(snapshot(backup)).toEqual(before)
    expect(read(userData, 'SELECT session_id FROM agent_session_tabs ORDER BY position')).toEqual(
      ['L0', 'L1', copyId('L3'), 'L4', 'L6', 'N', 'L7'].map((session_id) => ({ session_id }))
    )
    expect(read(userData, 'SELECT count(*) AS n FROM agent_session_records')).toEqual([{ n: 12 }])

    const rerun = run(userData, '--apply')
    expect(rerun.stdout).toContain('Already repaired')
    expect(read(userData, 'SELECT count(*) AS n FROM agent_session_tabs')).toEqual([{ n: 7 }])
  })

  // Chromium's SingletonLock symlink is how macOS and Linux show a running Orca.
  it.skipIf(process.platform === 'win32')(
    'refuses to apply while Orca holds the profile',
    async () => {
      const userData = writeProfile()
      // A live node process stands in for Orca's main process; test workers may rename themselves.
      const holder = spawn(
        process.execPath,
        ['-e', 'console.log(1); setInterval(() => {}, 1000)'],
        {
          stdio: ['ignore', 'pipe', 'ignore']
        }
      )
      try {
        // Until it prints, the child may still carry the test worker's name.
        await new Promise((resolve) => holder.stdout.once('data', resolve))
        symlinkSync(`${hostname()}-${holder.pid}`, path.join(userData, 'SingletonLock'))
        expect(findRunningOrca(userData)).toContain(String(holder.pid))
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
      } finally {
        holder.kill()
      }

      // orcad.lock outlives Orca; a reused PID or another machine's record must not read as this one.
      const lockDir = mkdtempSync(path.join(tmpdir(), 'orca-tab-repair-lock-'))
      roots.push(lockDir)
      const lock = { pid: process.pid, startedAtMs: 1_000_000, machineIdentity: 'here', host: 'h' }
      writeFileSync(path.join(lockDir, 'orcad.lock'), JSON.stringify(lock))
      const probe = { processName: () => 'Orca', machineIdentity: () => 'here', platform: 'darwin' }
      expect(findRunningOrca(lockDir, { ...probe, processStartedAtMs: () => 1_000_000 })).toContain(
        'running'
      )
      expect(findRunningOrca(lockDir, { ...probe, processStartedAtMs: () => 9_000_000 })).toBeNull()
      expect(findRunningOrca(lockDir, { ...probe, machineIdentity: () => 'there' })).toContain(
        'delete that file'
      )
      // Linux records carry start ticks: wall time drifting there doesn't make a live orcad stale.
      const linux = { ...lock, linuxStartTicks: '42', bootId: 'b' }
      writeFileSync(path.join(lockDir, 'orcad.lock'), JSON.stringify(linux))
      const onLinux = { ...probe, platform: 'linux', processStartedAtMs: () => 9_000_000 }
      const ticks = (startTicks) => ({
        ...onLinux,
        linuxIncarnation: () => ({ startTicks, bootId: 'b' })
      })
      expect(findRunningOrca(lockDir, ticks('42'))).toContain('running')
      expect(findRunningOrca(lockDir, ticks('43'))).toBeNull()
    }
  )
})
