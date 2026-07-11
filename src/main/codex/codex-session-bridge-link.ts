import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import {
  clearCopiedCodexSessionMarker,
  codexSessionSourceMatchesCopiedPrefix,
  codexSessionStatsMatchMarker,
  fingerprintCodexSessionFile,
  readCopiedCodexSessionMarker,
  writeCopiedCodexSessionMarker
} from './codex-session-copy-markers'
import {
  hasPreservedCodexSession,
  preservedCodexSessionPaths
} from './codex-session-preserved-copies'
import { installWithPreservedCodexSession } from './codex-session-preserved-install'

type TargetIdentityCheck = (candidatePath: string) => boolean

export function tryHardlinkSystemCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  try {
    // Why: Codex resume ignores symlinks, while a hardlink keeps one physical log.
    linkSync(sourcePath, targetPath)
    return true
  } catch {
    return false
  }
}

export function tryCopySystemCodexSessionFile(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  const replacementPath = `${targetPath}.orca-copy-${process.pid}-${Date.now()}`
  try {
    copyFileSync(sourcePath, replacementPath, constants.COPYFILE_EXCL)
    // Why: the complete temp copy is published with an exclusive same-volume
    // hardlink, so no process can observe partial bytes or be overwritten.
    linkSync(replacementPath, targetPath)
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to copy system Codex session:', sourcePath, error)
    return false
  } finally {
    rmSync(replacementPath, { force: true })
  }
  try {
    writeCopiedCodexSessionMarker(relativePath, sourcePath, targetPath)
  } catch (error) {
    // The complete exclusive copy remains usable but deliberately unowned; a
    // marker failure must not delete a file that another process may have opened.
    console.warn('[codex-session-bridge] Failed to mark copied Codex session:', sourcePath, error)
  }
  return true
}

/** Replaces an existing target with rollback, preferring a hardlink over a copy. */
export function replaceSystemCodexSessionBridge(
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  targetIdentityCheck: TargetIdentityCheck = () => true,
  preserveOriginal = false
): boolean {
  const replacementPath = `${targetPath}.orca-link-${process.pid}-${Date.now()}`
  try {
    const usesHardlink = tryHardlinkSystemCodexSessionFile(sourcePath, replacementPath)
    if (!usesHardlink) {
      copyFileSync(sourcePath, replacementPath)
    }
    return installPreparedCodexSessionBridge({
      sourcePath,
      targetPath,
      relativePath,
      replacementPath,
      usesHardlink,
      targetIdentityCheck,
      preserveOriginal
    })
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to replace Codex session bridge:',
      sourcePath,
      error
    )
    return false
  } finally {
    rmSync(replacementPath, { force: true })
  }
}

/** Migrates an unchanged legacy copy only when a hardlink is now available. */
export function migrateCopiedCodexSessionBridge(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  if (hasPreservedCodexSession(relativePath)) {
    warnPreservedCodexSessionRequiresReview(relativePath)
    return false
  }
  const marker = readCopiedCodexSessionMarker(relativePath)
  if (!marker || marker.sourcePath !== sourcePath) {
    return false
  }
  let replacementPath: string | null = null
  try {
    replacementPath = `${targetPath}.orca-link-${process.pid}-${Date.now()}`
    if (!tryHardlinkSystemCodexSessionFile(sourcePath, replacementPath)) {
      return false
    }
    const targetIdentity = copiedTargetIdentity(marker, targetPath)
    if (
      !targetIdentity ||
      !codexSessionSourceMatchesCopiedPrefix(
        sourcePath,
        marker,
        targetIdentity.fingerprintSha256
      )
    ) {
      return false
    }
    return installPreparedCodexSessionBridge({
      sourcePath,
      targetPath,
      relativePath,
      replacementPath,
      usesHardlink: true,
      targetIdentityCheck: targetIdentity.check,
      preserveOriginal: true
    })
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to migrate copied Codex session:',
      sourcePath,
      error
    )
    return false
  } finally {
    if (replacementPath) {
      rmSync(replacementPath, { force: true })
    }
  }
}

/** Refreshes only an unchanged managed copy whose append-only source grew. */
export function refreshCopiedCodexSessionBridge(
  sourcePath: string,
  targetPath: string,
  relativePath: string
): boolean {
  if (hasPreservedCodexSession(relativePath)) {
    warnPreservedCodexSessionRequiresReview(relativePath)
    return false
  }
  const marker = readCopiedCodexSessionMarker(relativePath)
  if (!marker || marker.sourcePath !== sourcePath) {
    return false
  }
  try {
    const targetStat = lstatSync(targetPath)
    const sourceStat = lstatSync(sourcePath)
    if (
      targetStat.isSymbolicLink() ||
      targetStat.isDirectory() ||
      !codexSessionStatsMatchMarker(targetStat, marker, 'target') ||
      sourceStat.size <= marker.sourceSize
    ) {
      return false
    }
    const targetIdentity = copiedTargetIdentity(marker, targetPath)
    if (
      !targetIdentity ||
      !codexSessionSourceMatchesCopiedPrefix(
        sourcePath,
        marker,
        targetIdentity.fingerprintSha256
      )
    ) {
      return false
    }
    return replaceSystemCodexSessionBridge(
      sourcePath,
      targetPath,
      relativePath,
      targetIdentity.check,
      true
    )
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Failed to refresh copied Codex session:',
      sourcePath,
      error
    )
    return false
  }
}

function copiedTargetIdentity(
  marker: NonNullable<ReturnType<typeof readCopiedCodexSessionMarker>>,
  targetPath: string
): { check: TargetIdentityCheck; fingerprintSha256: string } | null {
  const fingerprintSha256 =
    marker.targetFingerprintSha256 ?? fingerprintCodexSessionFile(targetPath)
  const check = (candidatePath: string): boolean => {
    const stat = lstatSync(candidatePath)
    return (
      !stat.isSymbolicLink() &&
      !stat.isDirectory() &&
      codexSessionStatsMatchMarker(stat, marker, 'target') &&
      fingerprintCodexSessionFile(candidatePath) === fingerprintSha256
    )
  }
  return check(targetPath) ? { check, fingerprintSha256 } : null
}

function installPreparedCodexSessionBridge(args: {
  sourcePath: string
  targetPath: string
  relativePath: string
  replacementPath: string
  usesHardlink: boolean
  targetIdentityCheck: TargetIdentityCheck
  preserveOriginal: boolean
}): boolean {
  if (args.preserveOriginal) {
    return installWithPreservedCodexSession(args)
  }
  return installReplaceableCodexSessionBridge(args)
}

function installReplaceableCodexSessionBridge(args: {
  sourcePath: string
  targetPath: string
  relativePath: string
  replacementPath: string
  usesHardlink: boolean
  targetIdentityCheck: TargetIdentityCheck
}): boolean {
  const backupPath = `${args.targetPath}.orca-backup-${process.pid}-${Date.now()}`
  if (!args.targetIdentityCheck(args.targetPath)) {
    return false
  }

  // Symlink metadata has no writable payload, but retain it until the prepared
  // replacement has installed. Never remove an installed replacement to roll
  // back a later marker failure; a writer may already have opened it.
  renameSync(args.targetPath, backupPath)
  if (!args.targetIdentityCheck(backupPath)) {
    restoreSymlinkBackupExclusively(backupPath, args.targetPath)
    return false
  }
  try {
    linkSync(args.replacementPath, args.targetPath)
  } catch (error) {
    if (existsSync(args.targetPath)) {
      console.warn(
        '[codex-session-bridge] Target appeared during symlink replacement; original retained:',
        backupPath,
        error
      )
    } else {
      restoreSymlinkBackupExclusively(backupPath, args.targetPath)
    }
    return false
  }
  try {
    if (args.usesHardlink) {
      clearCopiedCodexSessionMarker(args.relativePath)
    } else {
      writeCopiedCodexSessionMarker(args.relativePath, args.sourcePath, args.targetPath)
    }
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Installed replacement without marker update:',
      args.targetPath,
      error
    )
  }
  rmSync(backupPath, { force: true })
  return true
}

function restoreSymlinkBackupExclusively(backupPath: string, targetPath: string): void {
  try {
    symlinkSync(
      readlinkSync(backupPath),
      targetPath,
      process.platform === 'win32' ? 'file' : undefined
    )
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Symlink backup requires manual review:',
      backupPath,
      error
    )
  }
}

function warnPreservedCodexSessionRequiresReview(relativePath: string): void {
  console.warn(
    '[codex-session-bridge] Automatic refresh stopped; preserved copy requires review:',
    preservedCodexSessionPaths(relativePath).dataPath
  )
}
