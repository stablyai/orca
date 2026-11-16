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
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statfsSync,
  statSync
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { getAppDataDir } from '../instance-isolation/dev-instance-isolation.mjs'

export const DOMAIN_FILE = 'agent-session-domain.db'
export const LEGACY_FILE = 'agent-session-journal.db'
// Written with the first --apply, so a second run can't pick a different set of tabs.
export const REPAIR_MARKER = 'repair.migration-reopened-tabs.v1'
const CHAT_TAB_PREFIX = 'structured-agent-session-'

export function defaultUserDataPath(env = process.env, platform = process.platform) {
  return path.join(getAppDataDir(env, platform), 'orca')
}

/**
 * Opens a database read-only without touching anything beside it: a file with no -wal is read in
 * place as immutable; otherwise the file and its -wal are copied to a private folder first, since a
 * reader writes the -shm. Call close() on the result.
 */
export function openSnapshot(file) {
  if (!existsSync(`${file}-wal`)) {
    const url = pathToFileURL(path.resolve(file))
    url.searchParams.set('immutable', '1')
    const db = new DatabaseSync(url, { readOnly: true })
    return { db, close: () => db.close() }
  }
  const folder = mkdtempSync(path.join(tmpdir(), 'orca-chat-snapshot-'))
  try {
    const copy = path.join(folder, path.basename(file))
    // Clone where the filesystem can (APFS, Btrfs), else a full copy.
    copyFileSync(file, copy, constants.COPYFILE_FICLONE)
    copyFileSync(`${file}-wal`, `${copy}-wal`, constants.COPYFILE_FICLONE)
    const db = new DatabaseSync(copy, { readOnly: true })
    return {
      db,
      close: () => {
        db.close()
        rmSync(folder, { recursive: true, force: true })
      }
    }
  } catch (error) {
    rmSync(folder, { recursive: true, force: true })
    throw error
  }
}

/**
 * The tabs the faulty pass opened that nothing was written in since.
 *
 * The pass appended a tab per chat it touched to the end of the tab list, in the older journal's
 * record order, with an id derived from the chat. A duplicate copy's tab can only come from the
 * pass, and a tab opened later lands after it, so every tab from the first to the last duplicate
 * tab is the pass's. Below them, the pass's tabs continue while the record order keeps falling and
 * every gap is a chat in between whose tab was closed since. Tabs after the last duplicate stay
 * open: a chat the user reopened from history there can't be told apart.
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
  const legacyTabs = new Map(
    legacy
      .prepare('SELECT tab_id,session_id FROM agent_session_tabs')
      .all()
      .map((row) => [String(row.session_id), String(row.tab_id)])
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

  const chatState = (id) =>
    domain.prepare('SELECT epoch,last_sequence FROM journal_chat_state WHERE session_id=?').get(id)
  const revisions = (id, tables) => {
    const held = new Map()
    for (const table of tables.filter((name) => has(domain, name))) {
      for (const row of domain
        .prepare(`SELECT item_id AS id, revision FROM ${table} WHERE session_id=?`)
        .iterate(id)) {
        held.set(String(row.id), Math.max(held.get(String(row.id)) ?? -1, Number(row.revision)))
      }
    }
    return held
  }
  const items = (id) =>
    new Map(
      domain
        .prepare('SELECT item_id,revision,payload_json FROM journal_items WHERE session_id=?')
        .all(id)
        .map((row) => [String(row.item_id), row])
    )
  // A duplicate: its original here holds every item exactly as is (a removal leaves a tombstone)
  // and got as far. A later revision can't show which branch it grew from, so that copy is kept.
  const isDuplicate = (copy, id) => {
    const held = items(id)
    const removed = revisions(id, ['journal_item_tombstones'])
    for (const [item, row] of items(copy)) {
      const theirs = held.get(item)
      const same =
        theirs !== undefined &&
        Number(theirs.revision) === Number(row.revision) &&
        theirs.payload_json === row.payload_json
      if (!same && !((removed.get(item) ?? -1) >= Number(row.revision))) {
        return false
      }
    }
    const mine = chatState(copy)
    const theirs = chatState(id)
    return (
      !mine ||
      mine.epoch === null ||
      (theirs?.epoch !== undefined &&
        String(theirs.epoch) === String(mine.epoch) &&
        Number(theirs.last_sequence) >= Number(mine.last_sequence))
    )
  }
  const duplicates = new Set(
    [...copyOf].filter(([copy, id]) => isDuplicate(copy, id)).map(([copy]) => copy)
  )

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
    const state = chatState(session)
    if (!state || state.epoch === null) {
      return true
    }
    const { epoch, tip } = sourceTip(copyOf.get(session) ?? session)
    return String(state.epoch) === epoch && Number(state.last_sequence) === tip
  }

  const tabs = domain
    .prepare('SELECT tab_id,session_id,position FROM agent_session_tabs ORDER BY position')
    .all()
    .map((row) => ({
      tab: String(row.tab_id),
      session: String(row.session_id),
      position: Number(row.position)
    }))
  const order = (tab) => rank.get(copyOf.get(tab.session) ?? tab.session)
  const derivedId = (tab) => tab.tab === `${CHAT_TAB_PREFIX}${tab.session}`
  // The ids the pass gave: derived from the chat, or the older journal's own tab for an original.
  const passId = (tab) =>
    derivedId(tab) || (!copyOf.has(tab.session) && legacyTabs.get(tab.session) === tab.tab)
  // Tabs that were, or may have been, open before the pass: its copies' originals were converted
  // already, and the older journal showed the others.
  const openBefore = (tab) =>
    !copyOf.has(tab.session) && (copied.has(tab.session) || legacyTabs.has(tab.session))

  // A duplicate's tab can only come from the faulty pass; a later real downgrade appends its own
  // copies after tabs the user opened, so only duplicates bound the pass's tabs.
  const anchors = tabs.flatMap((tab, index) =>
    duplicates.has(tab.session) && derivedId(tab) ? [index] : []
  )
  const pass = []
  let leftOpen = 0
  if (anchors.length > 0) {
    const first = anchors[0]
    const last = anchors.at(-1)
    // Each gap is a tab the pass opened and the user closed since: a chat between these two.
    const follows = (lower, upper) => {
      const a = order(lower)
      const b = order(upper)
      return (
        a !== undefined &&
        b !== undefined &&
        passId(lower) &&
        passId(upper) &&
        upper.position - lower.position - 1 <= b - a - 1
      )
    }
    // A copied chat was converted before the pass, so its own tab was already there.
    let low = first
    while (low > 0 && !copied.has(tabs[low - 1].session) && follows(tabs[low - 1], tabs[low])) {
      low -= 1
    }
    pass.push(...tabs.slice(low, last + 1).filter(passId))
    // After the last duplicate, a chat reopened from history here looks just like the pass's tab.
    leftOpen = tabs
      .slice(last + 1)
      .filter(
        (tab) =>
          passId(tab) && order(tab) !== undefined && !openBefore(tab) && untouched(tab.session)
      ).length
  }

  const close = []
  const kept = { writtenSince: 0, openBefore: 0, olderBuildCopy: 0, notFromJournal: 0 }
  for (const tab of pass) {
    const original = copyOf.get(tab.session)
    if (original !== undefined && !duplicates.has(tab.session)) {
      kept.olderBuildCopy += 1
    } else if (order(tab) === undefined) {
      kept.notFromJournal += 1
    } else if (openBefore(tab)) {
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
    leftOpen,
    copies: {
      duplicates: [...duplicates].map((id) => ({ id, original: copyOf.get(id), name: name(id) })),
      olderBuildTurns: copyOf.size - duplicates.size
    }
  }
}

/** Why Orca may be using this profile, or null. Evidence that can't be checked counts as running. */
export function findRunningOrca(userData, probe = {}) {
  const host = probe.hostname ?? hostname()
  const alive = probe.isAlive ?? isAlive
  const name = probe.processName ?? processName
  const startedAt = probe.processStartedAtMs ?? processStartedAtMs
  const machine = probe.machineIdentity ?? machineIdentity
  const looksLikeOrca = (pid) => {
    const image = name(pid)
    // A reused PID after a crash belongs to something else; an unreadable name stays a refusal.
    return image === null || /orca|electron|node/i.test(image)
  }
  // Chromium's singleton: a "host-pid" symlink on macOS and Linux, removed when Orca quits.
  const singleton = path.join(userData, 'SingletonLock')
  if (lstatSync(singleton, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const target = readlinkSync(singleton)
    const dash = target.lastIndexOf('-')
    const lockHost = target.slice(0, dash)
    const pid = Number(target.slice(dash + 1))
    if (lockHost !== host) {
      return `Orca on ${lockHost} may be using this profile. If no Orca runs there, open and quit Orca here once to clear it`
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
  const lockPath = path.join(userData, 'orcad.lock')
  let record
  try {
    record = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
  if (!Number.isSafeInteger(record?.pid)) {
    return null
  }
  const ours = record.machineIdentity === undefined ? null : machine()
  const elsewhere =
    record.machineIdentity !== undefined
      ? ours !== record.machineIdentity
      : record.host !== undefined && record.host !== host
  if (elsewhere) {
    return `${lockPath} names ${record.host ?? 'another machine'}, process ${record.pid}. If no Orca or orcad runs there, delete that file`
  }
  if (!alive(record.pid) || !looksLikeOrca(record.pid)) {
    return null
  }
  const platform = probe.platform ?? process.platform
  if (record.linuxStartTicks !== undefined && record.bootId !== undefined) {
    // Linux records carry the kernel's own start identity; wall time there drifts.
    const actual = (probe.linuxIncarnation ?? linuxIncarnation)(record.pid)
    if (
      actual !== null &&
      (actual.bootId !== record.bootId || actual.startTicks !== record.linuxStartTicks)
    ) {
      return null
    }
  } else if (platform !== 'linux' && typeof record.startedAtMs === 'number') {
    const actual = startedAt(record.pid)
    // A different start time means the PID now belongs to another process.
    if (actual !== null && Math.abs(actual - record.startedAtMs) > 5000) {
      return null
    }
  }
  return `Orca is running (process ${record.pid})`
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function run(program, args) {
  try {
    return execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function processName(pid) {
  const output =
    process.platform === 'win32'
      ? run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      : run('ps', ['-p', String(pid), '-o', 'comm='])
  return output?.trim() || null
}

function processStartedAtMs(pid) {
  const output =
    process.platform === 'win32'
      ? run('powershell', [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`
        ])
      : run('ps', ['-p', String(pid), '-o', 'lstart='])
  const ms = output ? Date.parse(output.trim()) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

function linuxIncarnation(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Field 22, counted after the parenthesised command name, which may hold spaces.
    const startTicks = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/)[19]
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return startTicks && bootId ? { startTicks, bootId } : null
  } catch {
    return null
  }
}

/** The same machine identity Orca writes into orcad.lock. */
function machineIdentity() {
  if (process.platform === 'linux') {
    try {
      return readFileSync('/etc/machine-id', 'utf8').trim() || null
    } catch {
      return null
    }
  }
  if (process.platform === 'win32') {
    const guid = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(
      run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']) ?? ''
    )?.[1]
    return guid ? `win32-machine-guid:${guid.toLowerCase()}` : null
  }
  return (
    /"IOPlatformUUID"\s*=\s*"([^"]*)"/
      .exec(run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']) ?? '')?.[1]
      ?.toLowerCase() ?? null
  )
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
      `Not enough free disk space for the ${formatBytes(bytes)} backup next to ${userData}; nothing was changed.`
    )
  }
  mkdirSync(target, { mode: 0o700 })
  for (const file of files) {
    const from = path.join(userData, file)
    const to = path.join(target, file)
    copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    if (statSync(to).size !== statSync(from).size) {
      throw new Error(`Backing up ${file} came out incomplete; nothing was changed.`)
    }
  }
  return { directory: target, files, bytes }
}

/** One transaction: the selection is recomputed on the live file, so the result is what was read. */
export function closeTabs(userData, now = new Date()) {
  const legacy = openSnapshot(path.join(userData, LEGACY_FILE))
  try {
    const domain = new DatabaseSync(path.join(userData, DOMAIN_FILE))
    try {
      domain.exec('PRAGMA busy_timeout = 5000')
      domain.exec('BEGIN IMMEDIATE')
      try {
        const found = findMigrationReopenedTabs(legacy.db, domain)
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
    }
  } finally {
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
  const { writtenSince, openBefore, olderBuildCopy, notFromJournal } = found.kept
  const kept = writtenSince + openBefore + olderBuildCopy + notFromJournal
  console.log(
    `${applied ? 'Closed' : 'Would close'} ${found.close.length} of ${found.tabs} chat tabs the update opened that you haven't written in since (${found.close.length - copies} reopened chats, ${copies} duplicate copies).`
  )
  if (kept > 0) {
    console.log(
      `Keeping ${kept} other tabs it may have opened: ${writtenSince} you wrote in since, ${openBefore} that may have been open before it, ${olderBuildCopy} copies holding turns an older Orca saved, ${notFromJournal} chats started in this Orca.`
    )
  }
  if (found.leftOpen > 0) {
    console.log(
      `Leaving open ${found.leftOpen} tabs after the update's last copy: they may be the update's or ones you reopened. Close them by hand if you don't want them.`
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
  const legacy = openSnapshot(path.join(userData, LEGACY_FILE))
  let found
  try {
    const domain = openSnapshot(path.join(userData, DOMAIN_FILE))
    try {
      found = findMigrationReopenedTabs(legacy.db, domain.db)
    } finally {
      domain.close()
    }
  } finally {
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
  // Only the chat store changed; restoring the older journal would drop what an older build wrote.
  console.log(
    `To undo: quit Orca, delete ${DOMAIN_FILE}-wal and ${DOMAIN_FILE}-shm in ${userData} if present, then copy ${DOMAIN_FILE} and any ${DOMAIN_FILE}-wal/-shm from the backup folder back.`
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
