/**
 * The stores outside the profile that name a converted worktree (D1c), each converted once the
 * profile names the drive paths and recorded in the journal's ledger. Each is idempotent: a step
 * that crashed before its ledger entry finds its own earlier work and changes nothing.
 */
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PTY_SESSION_ID_SEPARATOR } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { isRecord } from '../../../shared/orcad-migration/orcad-migration-manifest-fields'
import { JournalSqlOwner } from '../../native-chat/agent-session-journal/journal-sql-owner'
import { getHistorySessionDirName } from '../../daemon/history/storage/history-paths'
import {
  durableWriteTempPath,
  syncDirectoryDurablySync,
  writeFileDurableSync
} from '../../filesystem/durable-file-write'
import { rewriteWslMoveOrchestrationHistoryFile } from '../../persistence/moving-wsl-projects/desktop-state/wsl-move-orchestration-history-rewrite'
import { hashWorktreeId } from '../../pty/history/terminal-history-id'

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
  run: (worktreeIds: ReadonlyMap<string, string>) => void | Promise<void>
}

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

/** Startup hands the database to the runtime only after this owner has physically exited. */
async function rewriteChatJournal(
  databasePath: string,
  ids: ReadonlyMap<string, string>
): Promise<void> {
  if (ids.size === 0) {
    return
  }
  const owner = new JournalSqlOwner(databasePath, dirname(databasePath))
  try {
    if (await owner.opened()) {
      throw new Error('chat workspace conversion requires a writable journal')
    }
    const result = await owner.maintain({ kind: 'wsl-workspace-rekey', worktreeIds: [...ids] })
    if (result !== true) {
      throw new Error('chat workspace conversion did not complete')
    }
  } finally {
    await owner.close()
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
