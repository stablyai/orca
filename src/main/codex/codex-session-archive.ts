import type { Stats } from 'node:fs'
import { lstat, unlink } from 'node:fs/promises'
import { readCodexSessionTargetStat } from './codex-session-backfill-audit-pass'

export async function readArchivedCodexSessionStat(filePath: string): Promise<Stats | null> {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (isNotFoundError(error)) {
      return null
    }
    throw error
  }
}

export async function removeRedundantActiveCodexSessionHardlink(
  managedSessionFilePath: string,
  systemSessionFilePath: string,
  archivedTargetStat: Stats
): Promise<void> {
  const [managedTargetStat, activeTargetStat] = await Promise.all([
    readCodexSessionTargetStat(managedSessionFilePath),
    readCodexSessionTargetStat(systemSessionFilePath)
  ])
  if (
    !managedTargetStat ||
    !activeTargetStat ||
    !isSameFile(managedTargetStat, archivedTargetStat) ||
    !isSameFile(activeTargetStat, archivedTargetStat)
  ) {
    return
  }
  // All three names identify the same rollout inode. The archived path is the
  // Codex-owned tombstone, so the active name is redundant backfill residue.
  try {
    await unlink(systemSessionFilePath)
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error
    }
  }
}

function isSameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
