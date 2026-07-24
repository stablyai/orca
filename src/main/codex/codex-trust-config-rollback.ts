import {
  chmodSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { MAX_AGENT_STATE_FILE_BYTES } from '../agent-state-file-reader'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'

export type CodexTrustConfigSnapshot =
  | { existed: false; restorePath?: string }
  | { existed: true; contents: Buffer; mode: number; restorePath: string }

function resolveConfigRestorePath(tomlPath: string): string {
  try {
    if (!lstatSync(tomlPath).isSymbolicLink()) {
      return tomlPath
    }
    try {
      return realpathSync.native(tomlPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      // Why: a dangling dotfiles link is still user-owned state. Target the
      // lexical destination so rollback removes an RPC-created file, not the link.
      return resolve(dirname(tomlPath), readlinkSync(tomlPath))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return tomlPath
    }
    throw error
  }
}

export function captureCodexTrustConfig(tomlPath: string): CodexTrustConfigSnapshot {
  const restorePath = resolveConfigRestorePath(tomlPath)
  try {
    // Why: contents and mode come from one descriptor, so a path replacement
    // cannot pair one file's bytes with another file's permissions.
    const { buffer, stats } = readNodeFileSyncWithinLimit(restorePath, MAX_AGENT_STATE_FILE_BYTES)
    return {
      existed: true,
      contents: buffer,
      mode: stats.mode,
      restorePath
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return restorePath === tomlPath ? { existed: false } : { existed: false, restorePath }
    }
    throw error
  }
}

export function restoreCodexTrustConfig(
  tomlPath: string,
  snapshot: CodexTrustConfigSnapshot
): void {
  if (!snapshot.existed) {
    try {
      unlinkSync(snapshot.restorePath ?? tomlPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    return
  }
  const { restorePath } = snapshot
  try {
    if (
      readNodeFileSyncWithinLimit(restorePath, MAX_AGENT_STATE_FILE_BYTES).buffer.equals(
        snapshot.contents
      )
    ) {
      // Why: the RPC may change permissions without changing bytes; rollback
      // restores the complete captured file state, not only its contents.
      chmodSync(restorePath, snapshot.mode)
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  // Why: rollback protects config integrity too; direct truncating writes can
  // leave Codex unusable if Orca exits midway through recovery.
  // Why: Codex's writer preserves config.toml symlinks. Restore through their
  // real target too, or Orca's atomic rename would disconnect dotfiles users.
  const tempPath = `${restorePath}.${process.pid}.${randomUUID()}.rollback.tmp`
  try {
    writeFileSync(tempPath, snapshot.contents, { mode: snapshot.mode })
    renameFileWithWindowsRetry(tempPath, restorePath)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // Best effort; preserve the rollback failure as the actionable error.
    }
    throw error
  }
}
