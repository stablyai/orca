#!/usr/bin/env node
// Closes the chat tabs a faulty one-time update (#42783) reopened on profiles whose chat store an
// internal build had copied before it. That pass reopened every closed chat and gave each converted
// chat a duplicate "continued" copy. Dev-only cleanup; Orca itself never runs this.
//
// Default is a dry run: it prints counts and changes nothing. --apply refuses while Orca uses the
// profile, backs up both chat databases (with -wal/-shm), then closes only the reopened tabs you
// haven't written in since. It never deletes a chat, record or copy; closed chats stay in history.
//
// Prompt for Claude Code or Codex, run from an up-to-date Orca checkout:
//   Run `node config/scripts/development/chat-store-repair/close-migration-reopened-tabs.mjs` (a dry run; add `--user-data <dir>` if my Orca data isn't in the default place).
//   Show me the counts it prints: reopened tabs I haven't used since, and the copies the update made.
//   Don't run anything else against my Orca data.
//   If it would close any tabs, ask me before running it again with `--apply`, and tell me to quit Orca first.
//   After `--apply`, show me the backup folder it prints.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  statfsSync,
  statSync
} from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { getAppDataDir } from '../instance-isolation/dev-instance-isolation.mjs'

export const DOMAIN_FILE = 'agent-session-domain.db'
export const LEGACY_FILE = 'agent-session-journal.db'
// Written with the first --apply, so a second run can't pick a different block of tabs.
export const REPAIR_MARKER = 'repair.migration-reopened-tabs.v1'

export function defaultUserDataPath(env = process.env, platform = process.platform) {
  return path.join(getAppDataDir(env, platform), 'orca')
}

/** Read-only, and without creating -wal/-shm beside a database that has none. */
export function openReadOnly(file) {
  if (existsSync(`${file}-wal`)) {
    return new DatabaseSync(file, { readOnly: true })
  }
  // No WAL means nothing beyond the main file to read; immutable skips SQLite's sidecar files.
  const url = pathToFileURL(path.resolve(file))
  url.searchParams.set('immutable', '1')
  return new DatabaseSync(url, { readOnly: true })
}

/**
 * The tabs the faulty pass opened that nothing was written in since. The pass appended one tab per
 * chat it touched, in the older journal's record order, at the end of the tab list; a copy took its
 * original's place. Anything that doesn't fit that pattern, or that the user wrote in, is kept.
 */
export function findMigrationReopenedTabs(legacy, domain) {
  const has = (db, table) =>
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table) !== undefined
  const meta = (key) =>
    domain.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)?.value
  const repaired = meta(REPAIR_MARKER)

  const legacyIds = legacy
    .prepare('SELECT session_id FROM agent_session_records ORDER BY rowid')
    .all()
    .map((row) => String(row.session_id))
  const rank = new Map(legacyIds.map((id, index) => [id, index]))
  const legacyTabbed = new Set(
    legacy
      .prepare('SELECT session_id FROM agent_session_tabs')
      .all()
      .map((row) => String(row.session_id))
  )
  const records = new Map(
    domain
      .prepare('SELECT session_id,record_json FROM agent_session_records')
      .all()
      .map((row) => [String(row.session_id), String(row.record_json)])
  )

  // The pass named a copy sha256(original id NUL revision) with the revision it recorded.
  const copyOf = new Map()
  for (const id of legacyIds) {
    const revision = meta(`journal.legacy-revision:${id}`)
    if (revision === undefined) {
      continue
    }
    const copy = createHash('sha256').update(`${id}\0${revision}`).digest('hex').slice(0, 32)
    if (records.has(copy)) {
      copyOf.set(copy, id)
    }
  }
  const copied = new Set(copyOf.values())

  // A real downgrade copy holds an item its original here never held (a removal leaves a tombstone).
  const itemsOf = (id, withTombstones) => {
    const held = new Set()
    for (const table of withTombstones
      ? ['journal_items', 'journal_item_tombstones']
      : ['journal_items']) {
      if (!has(domain, table)) {
        continue
      }
      for (const row of domain
        .prepare(`SELECT item_id AS id FROM ${table} WHERE session_id=?`)
        .iterate(id)) {
        held.add(String(row.id))
      }
    }
    return held
  }
  const olderBuildCopies = new Set(
    [...copyOf]
      .filter(([copy, id]) => {
        const held = itemsOf(id, true)
        return [...itemsOf(copy, false)].some((item) => !held.has(item))
      })
      .map(([copy]) => copy)
  )
  const duplicateCopies = [...copyOf.keys()].filter((copy) => !olderBuildCopies.has(copy))

  const hasOutcomes = has(legacy, 'journal_outcome_epochs')
  const sourceTip = (id) => {
    const session = legacy.prepare('SELECT epoch FROM journal_sessions WHERE session_id=?').get(id)
    if (!session) {
      return { epoch: null, tip: 0 }
    }
    const row = legacy
      .prepare(
        'SELECT seq FROM journal_rows WHERE session_id=? AND epoch=? ORDER BY seq DESC LIMIT 1'
      )
      .get(id, session.epoch)
    // Builds that save outcome records advance their coverage instead of appending rows.
    const outcome = hasOutcomes
      ? legacy
          .prepare('SELECT through_seq FROM journal_outcome_epochs WHERE session_id=? AND epoch=?')
          .get(id, session.epoch)
      : undefined
    return {
      epoch: String(session.epoch),
      tip: Math.max(Number(row?.seq ?? 0), Number(outcome?.through_seq ?? 0))
    }
  }
  // Untouched: never converted here, or converted and still at the original's tip.
  const untouched = (session) => {
    const state = domain
      .prepare('SELECT epoch,last_sequence FROM journal_chat_state WHERE session_id=?')
      .get(session)
    if (!state || state.epoch === null) {
      return true
    }
    const { epoch, tip } = sourceTip(copyOf.get(session) ?? session)
    return String(state.epoch) === epoch && Number(state.last_sequence) === tip
  }

  // The longest run of tabs, by position, whose chats rise strictly in the journal's record order.
  const tabs = domain
    .prepare('SELECT tab_id,session_id,position FROM agent_session_tabs ORDER BY position')
    .all()
    .map((row) => ({ tab: String(row.tab_id), session: String(row.session_id) }))
  let block = []
  let run = []
  let last = -1
  for (const tab of tabs) {
    const r = rank.get(copyOf.get(tab.session) ?? tab.session)
    if (r === undefined || r <= last) {
      run = []
    }
    if (r === undefined) {
      last = -1
      continue
    }
    run.push(tab)
    last = r
    if (run.length > block.length) {
      block = [...run]
    }
  }

  const close = []
  const kept = { writtenSince: 0, openBefore: 0, olderBuildCopy: 0 }
  // Only a run holding a duplicate copy is the faulty pass's; anything else could be the user's.
  const fromFaultyPass = block.some(
    (tab) => copyOf.has(tab.session) && !olderBuildCopies.has(tab.session)
  )
  for (const tab of fromFaultyPass ? block : []) {
    const original = copyOf.get(tab.session)
    if (original !== undefined && olderBuildCopies.has(tab.session)) {
      kept.olderBuildCopy += 1
    } else if (
      original === undefined &&
      (copied.has(tab.session) || legacyTabbed.has(tab.session))
    ) {
      // A chat the pass copied was converted, so its own tab predates the pass; one the older journal
      // showed may have been open all along.
      kept.openBefore += 1
    } else if (!untouched(tab.session)) {
      kept.writtenSince += 1
    } else {
      close.push({ ...tab, copy: original !== undefined })
    }
  }

  const name = (id) => {
    try {
      return JSON.parse(records.get(id) ?? '{}').conversationName ?? ''
    } catch {
      return ''
    }
  }
  return {
    repaired: repaired === undefined ? null : JSON.parse(repaired),
    tabs: tabs.length,
    close: repaired === undefined ? close : [],
    kept,
    copies: {
      duplicates: duplicateCopies.map((id) => ({ id, original: copyOf.get(id), name: name(id) })),
      olderBuildTurns: olderBuildCopies.size
    }
  }
}

/** Why Orca is using this profile, or null. Unknown evidence counts as running. */
export function findRunningOrca(userData, probe = {}) {
  const host = probe.hostname ?? hostname()
  const alive = probe.isAlive ?? isAlive
  const name = probe.processName ?? processName
  const looksLikeOrca = (pid) => {
    const image = name(pid)
    // A reused PID after a crash belongs to something else; an unreadable name stays a refusal.
    return image === null || /orca|electron|node/i.test(image)
  }
  // Chromium's singleton: a "host-pid" symlink on macOS and Linux.
  const singleton = path.join(userData, 'SingletonLock')
  if (lstatSync(singleton, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const target = readlinkSync(singleton)
    const dash = target.lastIndexOf('-')
    const lockHost = target.slice(0, dash)
    const pid = Number(target.slice(dash + 1))
    if (lockHost !== host) {
      return `Orca on ${lockHost} may be using this profile (${singleton})`
    }
    if (Number.isSafeInteger(pid) && pid > 0 && alive(pid) && looksLikeOrca(pid)) {
      return `Orca is running (process ${pid})`
    }
  }
  // On Windows, Chromium holds "lockfile" open without write sharing while it runs.
  const lockfile = path.join(userData, 'lockfile')
  if ((probe.platform ?? process.platform) === 'win32' && existsSync(lockfile)) {
    try {
      closeSync(openSync(lockfile, 'r+'))
    } catch (error) {
      if (['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) {
        return 'Orca is running (its lockfile is in use)'
      }
    }
  }
  // The desktop app and a standalone orcad both hold orcad.lock; it stays behind after they exit.
  try {
    const record = JSON.parse(readFileSync(path.join(userData, 'orcad.lock'), 'utf8'))
    if (
      Number.isSafeInteger(record?.pid) &&
      (record.host === undefined || record.host === host) &&
      alive(record.pid) &&
      looksLikeOrca(record.pid)
    ) {
      return `Orca is running (process ${record.pid})`
    }
  } catch {
    // No record, or a torn one from an exited process.
  }
  return null
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function processName(pid) {
  try {
    const output =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
            encoding: 'utf8'
          })
        : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' })
    return output.trim() || null
  } catch {
    return null
  }
}

/** Copies each database with its -wal/-shm; with Orca stopped, the files are consistent. */
export function backUpChatDatabases(userData, now = new Date()) {
  const files = [DOMAIN_FILE, LEGACY_FILE]
    .flatMap((file) => [file, `${file}-wal`, `${file}-shm`])
    .filter((file) => existsSync(path.join(userData, file)))
  const bytes = files.reduce((sum, file) => sum + statSync(path.join(userData, file)).size, 0)
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const target = `${path.resolve(userData)}-chat-backup-${stamp}`
  const free = statfsSync(path.dirname(target))
  if (free.bavail * free.bsize < bytes * 1.1) {
    throw new Error(
      `Not enough free disk space for the ${formatBytes(bytes)} backup next to ${userData}.`
    )
  }
  mkdirSync(target, { mode: 0o700 })
  for (const file of files) {
    const from = path.join(userData, file)
    const to = path.join(target, file)
    // Clone where the filesystem can (APFS, Btrfs), else a full copy.
    copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    if (statSync(to).size !== statSync(from).size) {
      throw new Error(`Backing up ${file} came out incomplete; nothing was changed.`)
    }
  }
  return { directory: target, files, bytes }
}

/** One transaction: the selection is recomputed on the live file, so the result is what was read. */
export function closeTabs(userData, now = new Date()) {
  const legacy = openReadOnly(path.join(userData, LEGACY_FILE))
  const domain = new DatabaseSync(path.join(userData, DOMAIN_FILE))
  try {
    domain.exec('PRAGMA busy_timeout = 5000')
    domain.exec('BEGIN IMMEDIATE')
    try {
      const found = findMigrationReopenedTabs(legacy, domain)
      const remove = domain.prepare(
        'DELETE FROM agent_session_tabs WHERE tab_id=? AND session_id=?'
      )
      for (const tab of found.close) {
        remove.run(tab.tab, tab.session)
      }
      if (found.repaired === null) {
        domain
          .prepare('INSERT INTO agent_session_store_meta (key, value) VALUES (?, ?)')
          .run(
            REPAIR_MARKER,
            JSON.stringify({ closedTabs: found.close.length, at: now.toISOString() })
          )
      }
      domain.exec('COMMIT')
      return found
    } catch (error) {
      domain.exec('ROLLBACK')
      throw error
    }
  } finally {
    domain.close()
    legacy.close()
  }
}

function formatBytes(bytes) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.ceil(bytes / 1024 ** 2)} MiB`
}

function parseArgs(argv) {
  const options = { apply: false, list: false, userData: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') {
      options.apply = true
    } else if (arg === '--list') {
      options.list = true
    } else if (arg === '--user-data') {
      options.userData = argv[++i]
    } else if (arg.startsWith('--user-data=')) {
      options.userData = arg.slice('--user-data='.length)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown option ${arg}. Run with --help.`)
    }
  }
  if (options.userData === undefined || options.userData === '') {
    throw new Error('--user-data needs a folder.')
  }
  return options
}

function printSummary(found, { applied }) {
  const copies = found.close.filter((tab) => tab.copy).length
  const kept = found.kept.writtenSince + found.kept.openBefore + found.kept.olderBuildCopy
  console.log(
    `${applied ? 'Closed' : 'Would close'} ${found.close.length} of ${found.tabs} chat tabs the update opened that you haven't written in since (${found.close.length - copies} reopened chats, ${copies} duplicate copies).`
  )
  if (kept > 0) {
    console.log(
      `Keeping ${kept} other tabs from that update: ${found.kept.writtenSince} you wrote in since, ${found.kept.openBefore} that may have been open before it, ${found.kept.olderBuildCopy} copies holding turns an older Orca saved.`
    )
  }
  console.log(
    `Copies the update made: ${found.copies.duplicates.length} duplicates and ${found.copies.olderBuildTurns} that hold turns an older Orca saved. They stay; delete duplicates by hand if you want (--list shows them).`
  )
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(
      [
        'Usage: node config/scripts/development/chat-store-repair/close-migration-reopened-tabs.mjs [--apply] [--list] [--user-data <dir>]',
        '',
        'Dry run by default: counts the chat tabs a faulty update reopened and the duplicate copies it made.',
        '--apply   Quit Orca first. Backs up both chat databases, then closes the reopened tabs you',
        "          haven't written in since. Chats stay in history; nothing is deleted.",
        '--list    Also lists those tabs and the duplicate copies.',
        `--user-data  Orca's data folder (default ${defaultUserDataPath()}).`
      ].join('\n')
    )
    return
  }
  const userData = path.resolve(options.userData ?? defaultUserDataPath())
  console.log(`Orca data: ${userData}`)
  if (
    !existsSync(path.join(userData, DOMAIN_FILE)) ||
    !existsSync(path.join(userData, LEGACY_FILE))
  ) {
    console.log('No chat store from before the update here, so there is nothing to repair.')
    return
  }
  const running = findRunningOrca(userData)
  const legacy = openReadOnly(path.join(userData, LEGACY_FILE))
  const domain = openReadOnly(path.join(userData, DOMAIN_FILE))
  let found
  try {
    found = findMigrationReopenedTabs(legacy, domain)
  } finally {
    domain.close()
    legacy.close()
  }
  if (found.repaired !== null) {
    console.log(
      `Already repaired on ${found.repaired.at} (${found.repaired.closedTabs} tabs closed). Nothing to do.`
    )
    return
  }
  printSummary(found, { applied: false })
  if (options.list) {
    for (const tab of found.close) {
      console.log(`  close tab ${tab.tab}`)
    }
    for (const copy of found.copies.duplicates) {
      console.log(
        `  duplicate copy ${copy.id} of ${copy.original}${copy.name ? ` "${copy.name}"` : ''}`
      )
    }
  }
  if (!options.apply) {
    console.log(
      found.close.length > 0
        ? `Dry run: nothing changed. Quit Orca, then run again with --apply to close them.${running ? ` (${running}.)` : ''}`
        : 'Dry run: nothing changed, and there is nothing to close.'
    )
    return
  }
  if (found.close.length === 0) {
    console.log('Nothing to close; no changes made.')
    return
  }
  if (running) {
    console.error(`${running}. Quit Orca and run again; nothing was changed.`)
    process.exitCode = 1
    return
  }
  const backup = backUpChatDatabases(userData)
  console.log(
    `Backed up ${backup.files.join(', ')} (${formatBytes(backup.bytes)}) to ${backup.directory}`
  )
  // The copy can take a while; make sure Orca didn't start meanwhile.
  const startedSince = findRunningOrca(userData)
  if (startedSince) {
    console.error(`${startedSince}. Quit Orca and run again; nothing was changed.`)
    process.exitCode = 1
    return
  }
  printSummary(closeTabs(userData), { applied: true })
  console.log(
    `To undo: quit Orca, delete agent-session-domain.db-wal and -shm in ${userData} if present, and copy the files from the backup folder back.`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
