// Validate blob contents before commit; install only advertised kinds after durable commit.
import { servesWslMovedPaneHistory } from '../../orcad/orcad-migration-wsl-destination'
import { readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { OrcadMigrationBlobKind } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY,
  parseOrcadMigrationTerminalRestoreHintsText,
  type OrcadMigrationTerminalRestoreHint
} from '../../../shared/orcad-migration/orcad-migration-terminal-restore-hints'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  getOrcadMigrationReceivedBlobPath,
  stagedOrcadMigrationBlobFiles
} from './orcad-migration-blob-staging'
import {
  orcadMigrationStagingKey,
  type OrcadMigrationRequestIdentity
} from './orcad-migration-staged-file'
import {
  assertOrcadMigrationShellHistoryValid,
  installOrcadMigrationShellHistory
} from './orcad-shell-history-installer'
import {
  assertOrcadMigrationTerminalHistoryValid,
  installOrcadMigrationTerminalHistory
} from './orcad-terminal-history-installer'
import type {
  OrcadTerminalRestoreHintPlacement,
  OrcadTerminalRestoreHintStore
} from './orcad-terminal-restore-hint-store'

type OrcadMigrationStagedBlobFile = {
  key: string
  path: string
  manifest: OrcadMigrationManifest
}

type OrcadMigrationBlobContentCheck = (file: OrcadMigrationStagedBlobFile) => void

const UTF8 = new TextDecoder('utf-8', { fatal: true })

const BLOB_CONTENT_CHECKS: Partial<Record<OrcadMigrationBlobKind, OrcadMigrationBlobContentCheck>> =
  {
    'terminal-restore-hints': ({ path }) => {
      parseOrcadMigrationTerminalRestoreHintsText(decodeUtf8(readFileSync(path)))
    },
    'shell-history': ({ key, path, manifest }) => {
      assertOrcadMigrationShellHistoryValid(key, path, manifest.payload)
    },
    'terminal-history': ({ key, path, manifest }) => {
      assertOrcadMigrationTerminalHistoryValid(key, path, manifest)
    }
  }

/** Reject malformed content before commit while the source still owns everything. */
export function assertOrcadMigrationBlobContentsValid(
  manifest: OrcadMigrationManifest,
  root: string
): void {
  for (const { descriptor, path } of stagedOrcadMigrationBlobFiles(manifest, root)) {
    const check = BLOB_CONTENT_CHECKS[descriptor.blobKind]
    if (!check) {
      continue
    }
    try {
      check({ key: descriptor.key, path, manifest })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`orcad_migration_blob_content_invalid:${descriptor.blobKind}:${reason}`)
    }
  }
}

export type OrcadMigrationBlobInstall = {
  migration: OrcadMigrationRequestIdentity
  root: string
  terminalRestoreHints: OrcadTerminalRestoreHintStore
  /** This host's getHistoryRoot(). */
  shellHistoryRoot: string
  /** This host's `getDaemonHistoryDir()`, where its terminals' checkpoints live. */
  terminalHistoryRoot: string
  /** The shell binary a new pane on this host would actually run. */
  paneShellPath: () => string
  /** Defer without runtime evidence: shells surviving a restart could overwrite installed history. */
  worktreeHasLiveShells?: (worktreeId: string) => boolean
  deferredShellHistoryWorktreeIds: Set<string>
  paneWorktreeId: (paneKey: string) => string | null
  /** The workspace's folder on this host, or null when it is not here. */
  workspacePath: (worktreeId: string) => string | null
  now: number
}

/** Retain failed blobs for retry; installed-migration markers prevent consumed hints from reviving. */
export function installOrcadMigrationReceivedBlobs(install: OrcadMigrationBlobInstall): void {
  let firstError: unknown = null
  // Keep failures independent so other blob kinds can still install.
  for (const installKind of [
    installTerminalRestoreHints,
    installShellHistory,
    installTerminalHistory
  ]) {
    try {
      installKind(install)
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== null) {
    throw firstError
  }
}

function installTerminalHistory(install: OrcadMigrationBlobInstall): void {
  // Only a WSL host advertises terminal history, so no other destination should hold any.
  if (!servesWslMovedPaneHistory()) {
    return
  }
  installOrcadMigrationTerminalHistory({
    migration: install.migration,
    root: install.root,
    historyRoot: install.terminalHistoryRoot,
    paneWorktreeId: install.paneWorktreeId,
    workspacePath: install.workspacePath,
    now: install.now
  })
}

function installShellHistory(install: OrcadMigrationBlobInstall): void {
  if (!install.worktreeHasLiveShells) {
    return
  }
  installOrcadMigrationShellHistory({
    migration: install.migration,
    root: install.root,
    historyRoot: install.shellHistoryRoot,
    paneShellPath: install.paneShellPath,
    worktreeHasLiveShells: install.worktreeHasLiveShells,
    deferredWorktreeIds: install.deferredShellHistoryWorktreeIds,
    now: install.now
  })
}

function installTerminalRestoreHints(install: OrcadMigrationBlobInstall): void {
  const path = getOrcadMigrationReceivedBlobPath(install.root, install.migration, {
    blobKind: 'terminal-restore-hints',
    key: ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY
  })
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return
  }
  const migrationKey = orcadMigrationStagingKey(install.migration)
  if (!install.terminalRestoreHints.hasInstalledMigration(migrationKey)) {
    try {
      const document = parseOrcadMigrationTerminalRestoreHintsText(decodeUtf8(bytes))
      install.terminalRestoreHints.install(
        { migrationKey, migrationId: install.migration.migrationId },
        placeHints(document.hints, install.paneWorktreeId),
        install.now
      )
    } catch (error) {
      if (!isHintFormatError(error)) {
        throw error
      }
      // Pre-commit validation passed; damaged hints can only fall back to the default folder now.
      console.error(
        `[orcad-migration] dropped unreadable terminal restore hints for ${install.migration.migrationId}:`,
        error
      )
    }
  }
  rmSync(path, { force: true })
  syncDirectoryDurablySync(dirname(path))
}

// Drop hints whose panes have no worktree on this host.
function placeHints(
  hints: readonly OrcadMigrationTerminalRestoreHint[],
  paneWorktreeId: (paneKey: string) => string | null
): OrcadTerminalRestoreHintPlacement[] {
  return hints.flatMap((hint) => {
    const worktreeId = paneWorktreeId(hint.paneKey)
    return worktreeId ? [{ ...hint, worktreeId }] : []
  })
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new Error('orcad_migration_terminal_restore_hints_not_utf8')
  }
}

function isHintFormatError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('orcad_migration_terminal_restore_')
}
