/**
 * Installs a moved pane's `terminal-history` blob as an interrupted session in this host's daemon
 * history folder, under an id derived from the pane. The pane's first start claims that session and
 * cold-restores the checkpoint once (history, screen and cwd); the daemon's own checkpoints take over.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import {
  MOVED_PANE_HISTORY_SESSION_TAG,
  parseOrcadMigrationTerminalHistoryText,
  type OrcadMigrationTerminalHistoryDocument
} from '../../../shared/orcad-migration/orcad-migration-terminal-history'
import { PTY_SESSION_ID_SEPARATOR } from '../../../shared/pty-session-id-format'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { getHistorySessionDirName } from '../../daemon/history-paths'
import { isTerminalCheckpointFile } from '../../daemon/terminal-history-checkpoint-reader'
import type { SessionMeta } from '../../daemon/terminal-history-metadata'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  getOrcadMigrationReceivedBlobPath,
  listOrcadMigrationReceivedBlobNames
} from './orcad-migration-blob-staging'
import type { OrcadMigrationRequestIdentity } from './orcad-migration-staged-file'

const UTF8 = new TextDecoder('utf-8', { fatal: true })

export function orcadMigrationTerminalHistoryKey(paneKey: string): string {
  return createHash('sha256').update(paneKey).digest('hex').slice(0, 16)
}

/** The session a moved pane restores as on this host; minted for its worktree like any other. */
export function movedPaneHistorySessionId(worktreeId: string, paneKey: string): string {
  return `${worktreeId}${PTY_SESSION_ID_SEPARATOR}${MOVED_PANE_HISTORY_SESSION_TAG}${orcadMigrationTerminalHistoryKey(paneKey)}`
}

/** Before the commit: the bytes must be a checkpoint for a terminal pane this manifest moves. */
export function assertOrcadMigrationTerminalHistoryValid(
  key: string,
  path: string,
  manifest: OrcadMigrationManifest
): void {
  const document = readDocument(path)
  if (orcadMigrationTerminalHistoryKey(document.paneKey) !== key) {
    throw new Error('orcad_migration_terminal_history_key_mismatch')
  }
  if (!isTerminalCheckpointFile(document.checkpoint)) {
    throw new Error('orcad_migration_terminal_history_checkpoint_invalid')
  }
  if (findPaneWorktreeId(manifest, document.paneKey) === null) {
    throw new Error('orcad_migration_terminal_history_pane_not_moved')
  }
}

export type OrcadMigrationTerminalHistoryInstall = {
  migration: OrcadMigrationRequestIdentity
  root: string
  /** This host's daemon history folder (`getDaemonHistoryDir()`). */
  historyRoot: string
  /** The worktree that owns the pane on this host, or null when the pane is not here. */
  paneWorktreeId: (paneKey: string) => string | null
  /** Where a pane with no recorded folder starts: its workspace's folder on this host. */
  workspacePath: (worktreeId: string) => string | null
  now: number
}

/**
 * Idempotent: a session folder that already holds `meta.json` is the pane's own by now (restored,
 * or written since), so the blob is only deleted. A write failure keeps the blob for the retry.
 */
export function installOrcadMigrationTerminalHistory(
  install: OrcadMigrationTerminalHistoryInstall
): void {
  for (const key of listOrcadMigrationReceivedBlobNames(
    install.root,
    install.migration,
    'terminal-history'
  )) {
    const path = getOrcadMigrationReceivedBlobPath(install.root, install.migration, {
      blobKind: 'terminal-history',
      key
    })
    let document: OrcadMigrationTerminalHistoryDocument | null = null
    try {
      document = readDocument(path)
    } catch (error) {
      // The pre-commit check passed these bytes, so only a damaged file lands here; the pane
      // starts fresh rather than holding back the rest of the move.
      console.error(
        `[orcad-migration] dropped unreadable terminal history for ${install.migration.migrationId}:`,
        error
      )
    }
    const worktreeId = document ? install.paneWorktreeId(document.paneKey) : null
    const cwd = worktreeId ? (document?.cwd ?? install.workspacePath(worktreeId)) : null
    if (document && worktreeId && cwd) {
      writeSessionFolder(
        install.historyRoot,
        movedPaneHistorySessionId(worktreeId, document.paneKey),
        { ...document, cwd },
        install.now
      )
    }
    rmSync(path, { force: true })
    syncDirectoryDurablySync(dirname(path))
  }
}

function writeSessionFolder(
  historyRoot: string,
  sessionId: string,
  document: OrcadMigrationTerminalHistoryDocument & { cwd: string },
  now: number
): void {
  const dir = join(historyRoot, getHistorySessionDirName(sessionId))
  const metaPath = join(dir, 'meta.json')
  if (existsSync(metaPath)) {
    return
  }
  // A crash before meta.json left no session yet; redo the folder whole.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeAtomically(
    join(dir, 'checkpoint.json'),
    JSON.stringify({ ...document.checkpoint, cwd: document.cwd })
  )
  const meta: SessionMeta = {
    cwd: document.cwd,
    cols: document.cols,
    rows: document.rows,
    startedAt: new Date(now).toISOString(),
    // Why null: only an unended session cold-restores, and this one never ran on this host.
    endedAt: null,
    exitCode: null
  }
  // Why last: meta.json is what makes the folder a session.
  writeAtomically(metaPath, JSON.stringify(meta))
  syncDirectoryDurablySync(dir)
}

function writeAtomically(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

function readDocument(path: string): OrcadMigrationTerminalHistoryDocument {
  let text: string
  try {
    text = UTF8.decode(readFileSync(path))
  } catch {
    throw new Error('orcad_migration_terminal_history_not_utf8')
  }
  return parseOrcadMigrationTerminalHistoryText(text)
}

function findPaneWorktreeId(manifest: OrcadMigrationManifest, paneKey: string): string | null {
  const pane = parsePaneKey(paneKey)
  const session = manifest.payload.dormantState?.workspaceSession
  if (!pane || !session) {
    return null
  }
  const owner = Object.entries(session.tabsByWorktree ?? {}).find(([, tabs]) =>
    tabs.some((tab) => tab.id === pane.tabId)
  )?.[0]
  const layout = session.terminalLayoutsByTabId?.[pane.tabId]
  return owner && layout ? owner : null
}
