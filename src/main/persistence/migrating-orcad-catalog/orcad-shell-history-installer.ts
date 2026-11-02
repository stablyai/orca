/**
 * Destination half of the `shell-history` blob: a pre-commit check that each file names a worktree
 * of the migrated catalog, and the post-commit install into this host's history root at the path
 * a zsh/bash pane in that worktree gets as HISTFILE (`<root>/<hash>/<shell>_history`).
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { projectGroupIdFromRepoId } from '../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  durableWriteTempPath,
  syncDirectoryDurablySync,
  writeFileDurableSync
} from '../../durable-file-write'
import { resolveUnixPaneShellPath } from '../../daemon/shell-ready'
import { resolveUnixShellPath } from '../../providers/local-pty-utils'
import { readHistoryMeta, resolveShellKind } from '../../terminal-history'
import {
  getOrcadMigrationReceivedBlobPath,
  listOrcadMigrationReceivedBlobNames
} from './orcad-migration-blob-staging'
import {
  ORCAD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES,
  parseOrcadMigrationShellHistoryHeader,
  parseOrcadMigrationShellHistoryKey,
  shellHistoryFileName,
  type OrcadMigrationShellHistoryShell
} from './orcad-migration-shell-history-format'
import type { OrcadMigrationRequestIdentity } from './orcad-migration-staged-file'

type ShellHistoryCatalog = Pick<
  OrcadMigrationManifest['payload'],
  'repositories' | 'projectGroups' | 'folderWorkspaces'
>

/** Throws unless the staged file is a well-formed history for a worktree this catalog moves. */
export function assertOrcadMigrationShellHistoryValid(
  key: string,
  path: string,
  catalog: ShellHistoryCatalog
): void {
  const { worktreeId } = parseOrcadMigrationShellHistoryHeader(
    key,
    readHead(path, ORCAD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES),
    statSync(path).size
  )
  // Refused, not dropped: only a sender bug names a worktree outside the catalog, and dropping
  // the file would lose that history without anyone noticing.
  if (!catalogOwnsWorktree(catalog, worktreeId)) {
    throw new Error('orcad_migration_shell_history_worktree_not_migrated')
  }
}

export type OrcadShellHistoryInstall = {
  migration: OrcadMigrationRequestIdentity
  root: string
  /** This host's `getHistoryRoot()`. */
  historyRoot: string
  /** The shell binary a new pane on this host would actually run; see `resolveNewPaneShellPath`. */
  paneShellPath: () => string
  /** True while a shell runs in the worktree. */
  worktreeHasLiveShells: (worktreeId: string) => boolean
  /** Worktrees whose install waits for their live shells to exit. */
  deferredWorktreeIds: Set<string>
  now: number
}

/**
 * Installs every received history file, then deletes it. Already installed (meta.json records the
 * blob) only deletes. A worktree with a live shell keeps its blob: that shell would overwrite the
 * file from its own memory on exit. A write failure keeps the blob for the next retry and is
 * rethrown once the others had their turn.
 */
export function installOrcadMigrationShellHistory(install: OrcadShellHistoryInstall): void {
  let firstError: unknown = null
  for (const key of listOrcadMigrationReceivedBlobNames(
    install.root,
    install.migration,
    'shell-history'
  )) {
    if (!ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].key.test(key)) {
      continue
    }
    try {
      installOne(install, key)
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== null) {
    throw firstError
  }
}

type ReceivedShellHistory = {
  worktreeId: string
  worktreeHash: string
  shell: OrcadMigrationShellHistoryShell
  sha256: string
  history: Buffer
}

function installOne(install: OrcadShellHistoryInstall, key: string): void {
  const path = getOrcadMigrationReceivedBlobPath(install.root, install.migration, {
    blobKind: 'shell-history',
    key
  })
  const bytes = readFileSync(path)
  let moved: ReceivedShellHistory
  try {
    const header = parseOrcadMigrationShellHistoryHeader(key, bytes, bytes.length)
    const { worktreeHash, shell } = parseOrcadMigrationShellHistoryKey(key)
    moved = {
      worktreeId: header.worktreeId,
      worktreeHash,
      shell: header.loginShell ? (paneHistoryShell(install.paneShellPath) ?? shell) : shell,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      history: withFinalNewline(bytes.subarray(header.byteLength))
    }
  } catch (error) {
    // The pre-commit check passed these bytes, so only a damaged file lands here.
    console.error(`[orcad-migration] dropped unreadable shell history ${key}:`, error)
    removeReceived(path)
    return
  }
  const directory = join(install.historyRoot, moved.worktreeHash)
  const meta = readHistoryMeta(directory)
  // Keyed by sha alone, so a pane shell that changed between attempts cannot install it twice.
  if (meta?.installedMigrationBlobs?.some((blob) => blob.sha256 === moved.sha256)) {
    removeReceived(path)
    return
  }
  if (install.worktreeHasLiveShells(moved.worktreeId)) {
    install.deferredWorktreeIds.add(moved.worktreeId)
    return
  }
  // Owner-only, like the history directories terminal-history.ts creates.
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeHistoryFile(join(directory, shellHistoryFileName(moved.shell)), moved.history)
  writeMeta(directory, moved, install.now)
  removeReceived(path)
  install.deferredWorktreeIds.delete(moved.worktreeId)
}

// A history without a final newline would run its last command into the host's next one.
function withFinalNewline(history: Buffer): Buffer {
  return history.at(-1) === 0x0a ? history : Buffer.concat([history, Buffer.from('\n')])
}

/**
 * The host normally has no history for a worktree that just arrived. If it has some, nothing is
 * overwritten: the moved history goes first (it is older) and the host's own lines follow, so the
 * newest commands stay at the end where shells read them back from.
 */
function writeHistoryFile(path: string, moved: Buffer): void {
  const existing = readExisting(path)
  // A crash between this write and the meta.json marker leaves the moved bytes already in front.
  if (existing?.subarray(0, moved.length).equals(moved)) {
    return
  }
  const content = existing ? Buffer.concat([moved, existing]) : moved
  const target = writeTarget(path)
  writeFileDurableSync(durableWriteTempPath(target), target, content, 0o600)
}

// A symlinked HISTFILE is written through to its target so the link the user set up survives.
function writeTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }
  }
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path
  } catch (error) {
    if (isMissing(error)) {
      return path
    }
    throw error
  }
}

// GC prunes a history directory by its meta.json worktree id, so it must name the host's id.
function writeMeta(directory: string, moved: ReceivedShellHistory, now: number): void {
  const existing = readHistoryMeta(directory)
  const path = join(directory, 'meta.json')
  const meta = {
    ...existing,
    worktreeId: moved.worktreeId,
    createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    installedMigrationBlobs: [
      ...(existing?.installedMigrationBlobs ?? []),
      { sha256: moved.sha256, shell: moved.shell }
    ]
  }
  writeFileDurableSync(durableWriteTempPath(path), path, JSON.stringify(meta), 0o600)
}

/**
 * A login-shell history from the WSL bridge (see the header's `loginShell`) lands under the file a
 * new pane on this host reads: `zsh_history` or `bash_history` when that pane runs zsh or bash,
 * `bash_history` for any other shell.
 */
function paneHistoryShell(paneShellPath: () => string): OrcadMigrationShellHistoryShell | null {
  const kind = resolveShellKind(paneShellPath())
  return kind === 'zsh' || kind === 'bash' ? kind : null
}

/**
 * The shell a new pane spawns, resolved as the spawn does: the host's default-shell setting, then
 * SHELL, then the first executable fallback. With no executable shell at all, no pane runs here.
 */
export function resolveNewPaneShellPath(defaultShell: string | undefined): string {
  try {
    return resolveUnixShellPath(resolveUnixPaneShellPath({}, undefined, defaultShell))
  } catch {
    return ''
  }
}

function readExisting(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function removeReceived(path: string): void {
  rmSync(path, { force: true })
  syncDirectoryDurablySync(dirname(path))
}

function readHead(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function catalogOwnsWorktree(catalog: ShellHistoryCatalog, worktreeId: string): boolean {
  if (
    catalog.folderWorkspaces.some((workspace) => folderWorkspaceKey(workspace.id) === worktreeId)
  ) {
    return true
  }
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.repoId || !parsed.worktreePath) {
    return false
  }
  const projectGroupId = projectGroupIdFromRepoId(parsed.repoId)
  return projectGroupId
    ? catalog.projectGroups.some((group) => group.id === projectGroupId)
    : catalog.repositories.some((repo) => repo.id === parsed.repoId)
}
