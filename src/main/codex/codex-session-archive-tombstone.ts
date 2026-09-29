import type { BigIntStats } from 'node:fs'
import { lstat, unlink } from 'node:fs/promises'

export async function readArchivedCodexSessionStat(filePath: string): Promise<BigIntStats | null> {
  try {
    return await lstat(filePath, { bigint: true })
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
  archivedTargetStat: BigIntStats
): Promise<void> {
  const [managedTargetStat, activeTargetStat] = await Promise.all([
    readArchivedCodexSessionStat(managedSessionFilePath),
    readArchivedCodexSessionStat(systemSessionFilePath)
  ])
  if (
    !managedTargetStat ||
    !activeTargetStat ||
    !isSameFile(managedTargetStat, archivedTargetStat) ||
    !isSameFile(activeTargetStat, archivedTargetStat)
  ) {
    return
  }
  // The archived name is Codex's durable state; only a matching backfill hardlink is redundant.
  try {
    await unlink(systemSessionFilePath)
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error
    }
  }
}

export async function removeNewActiveCodexSessionLink(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error
    }
  }
}

function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function isNotFoundError(error: unknown): boolean {
  return isErrorWithCode(error) && error.code === 'ENOENT'
}

function isErrorWithCode(error: unknown): error is { code: unknown } {
  return typeof error === 'object' && error !== null && 'code' in error
}
