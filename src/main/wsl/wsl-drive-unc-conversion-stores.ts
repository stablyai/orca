/**
 * The stores outside the profile that name a converted worktree (D1c), each converted once the
 * profile names the drive paths and recorded in the journal's ledger. Each is idempotent: a step
 * that crashed before its ledger entry finds its own earlier work and changes nothing.
 */
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { PTY_SESSION_ID_SEPARATOR } from '../../shared/pty-session-id-format'
import { isRecord } from '../../shared/orcad-migration/orcad-migration-manifest-fields'
import { getHistorySessionDirName } from '../daemon/history-paths'
import {
  durableWriteTempPath,
  syncDirectoryDurablySync,
  writeFileDurableSync
} from '../durable-file-write'
import { rewriteWslMoveOrchestrationHistoryFile } from '../persistence/moving-wsl-projects/wsl-move-orchestration-history-rewrite'
import Database from '../sqlite/sync-database'
import { hashWorktreeId } from '../terminal-history-id'

export type WslDriveUncConversionStorePaths = {
  /** The daemon's `terminal-history`: one folder per terminal session, named by its id. */
  daemonHistoryDir: string
  /** Shell history folders keyed by the worktree id's hash, native and per distro. */
  shellHistoryRoots: readonly string[]
  orchestrationDatabasePath: string
  chatJournalDatabasePath: string
}

export type WslDriveUncConversionStore = {
  id: string
  /** Durable when it returns. */
  run: (worktreeIds: ReadonlyMap<string, string>) => void
}

// The lock wait blocks the main thread (synchronous SQLite); a busy database retries next start.
const BUSY_TIMEOUT_MS = 2_000

export const WSL_DRIVE_UNC_MAIN_STORE_IDS = [
  'terminal-history',
  'shell-history',
  'orchestration-history',
  'chat-journal'
] as const

/** In ledger order, as WSL_DRIVE_UNC_MAIN_STORE_IDS lists them. */
export function wslDriveUncConversionStores(
  paths: WslDriveUncConversionStorePaths
): WslDriveUncConversionStore[] {
  return [
    {
      id: 'terminal-history',
      run: (ids) => renameTerminalSessions(paths.daemonHistoryDir, ids)
    },
    {
      id: 'shell-history',
      run: (ids) => paths.shellHistoryRoots.forEach((root) => renameShellHistories(root, ids))
    },
    {
      id: 'orchestration-history',
      run: (ids) =>
        rewriteWslMoveOrchestrationHistoryFile(paths.orchestrationDatabasePath, {
          inScope: (worktreeId) => ids.has(worktreeId),
          worktreeId: (worktreeId) => ids.get(worktreeId) ?? worktreeId
        })
    },
    {
      id: 'chat-journal',
      run: (ids) => rewriteChatJournal(paths.chatJournalDatabasePath, ids)
    }
  ]
}

/**
 * A slept pane's session id embeds its worktree id, and the pane wakes by reattaching to that id:
 * its folder (checkpoint, output log) follows the id, so wake restores its scrollback and folder.
 * The folder holds no id of its own (meta.json is cwd, size and times).
 */
function renameTerminalSessions(dir: string, ids: ReadonlyMap<string, string>): void {
  if (!existsSync(dir)) {
    return
  }
  let renamed = false
  for (const name of readdirSync(dir)) {
    const sessionId = safeDecode(name)
    const at = sessionId?.lastIndexOf(PTY_SESSION_ID_SEPARATOR) ?? -1
    const owner = sessionId && at > 0 ? ids.get(sessionId.slice(0, at)) : undefined
    if (!sessionId || !owner) {
      continue
    }
    const target = join(dir, getHistorySessionDirName(`${owner}${sessionId.slice(at)}`))
    // Already there: a resumed run, or a session the woken pane started since.
    if (!existsSync(target)) {
      renameSync(join(dir, name), target)
      renamed = true
    }
  }
  if (renamed) {
    syncDirectoryDurablySync(dir)
  }
}

/** Bash and zsh history follows the hashed id; fish keeps its own file by session name. */
function renameShellHistories(root: string, ids: ReadonlyMap<string, string>): void {
  if (!existsSync(root)) {
    return
  }
  let renamed = false
  for (const [oldId, newId] of ids) {
    const from = join(root, hashWorktreeId(oldId))
    const to = join(root, hashWorktreeId(newId))
    if (existsSync(from) && !existsSync(to)) {
      renameSync(from, to)
      renamed = true
    }
    // The history sweep keeps a folder whose meta names a live worktree.
    rewriteShellHistoryMeta(to, oldId, newId)
  }
  if (renamed) {
    syncDirectoryDurablySync(root)
  }
}

function rewriteShellHistoryMeta(dir: string, oldId: string, newId: string): void {
  const path = join(dir, 'meta.json')
  let meta: unknown
  try {
    meta = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Missing, or torn by a crash: the history file is what matters, and a throw here would stall
    // every later startup before the chats are re-keyed.
    return
  }
  if (isRecord(meta) && meta.worktreeId === oldId) {
    const payload = JSON.stringify({ ...meta, worktreeId: newId })
    writeFileDurableSync(durableWriteTempPath(path), path, payload, 0o600)
  }
}

/**
 * A chat's workspace is its record's `location.workspaceId` and its journal session's
 * `workspace_id`; its provider still runs in the same distro, at the same folder. One transaction.
 */
function rewriteChatJournal(databasePath: string, ids: ReadonlyMap<string, string>): void {
  if (!existsSync(databasePath) || ids.size === 0) {
    return
  }
  const db = new Database(databasePath, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS })
  try {
    db.pragma('synchronous = FULL')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (hasTable(db, 'journal_sessions')) {
        const update = db.prepare(
          'UPDATE journal_sessions SET workspace_id = ? WHERE workspace_id = ?'
        )
        for (const [oldId, newId] of ids) {
          update.run(newId, oldId)
        }
      }
      if (hasTable(db, 'agent_session_records')) {
        const update = db.prepare(
          'UPDATE agent_session_records SET record_json = ? WHERE session_id = ?'
        )
        for (const row of db
          .prepare('SELECT session_id, record_json FROM agent_session_records')
          .all()) {
          const next =
            typeof row.record_json === 'string' ? rekeyChatRecord(row.record_json, ids) : null
          if (next !== null) {
            update.run(next, row.session_id)
          }
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

/** The record with its workspace re-keyed; null when it names none of `ids` or can't be read. */
function rekeyChatRecord(json: string, ids: ReadonlyMap<string, string>): string | null {
  let record: unknown
  try {
    record = JSON.parse(json)
  } catch {
    // A row this build can't read stays byte-identical, as the journal promises.
    return null
  }
  if (!isRecord(record) || !isRecord(record.location)) {
    return null
  }
  const workspaceId = record.location.workspaceId
  const next = typeof workspaceId === 'string' ? ids.get(workspaceId) : undefined
  return next
    ? JSON.stringify({ ...record, location: { ...record.location, workspaceId: next } })
    : null
}

function hasTable(db: Database, table: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  )
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
