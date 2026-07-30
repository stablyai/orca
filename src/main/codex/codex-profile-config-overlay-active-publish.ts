import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, renameSync, unlinkSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

export function publishActiveManagedOverlay({
  fileName,
  managedContents,
  replaceExisting,
  targetPath
}: {
  fileName: string
  managedContents: string
  replaceExisting: boolean
  targetPath: string
}): void {
  const stagePath = uniqueOverlaySiblingPath(targetPath, 'stage', 'tmp')
  try {
    // The existing writer prepares a complete same-directory file; a hard
    // link then publishes it without replacing a concurrent target.
    writeFileAtomically(stagePath, managedContents)
    // Verify hard-link support before moving the old target; otherwise a
    // persistent filesystem/ACL failure would strand it in quarantine.
    if (replaceExisting && !canPublishProfileOverlayByHardLink(stagePath, targetPath, fileName)) {
      return
    }
    const quarantinePath = replaceExisting
      ? quarantineProfileOverlayTarget(targetPath, fileName)
      : null
    if (quarantinePath === undefined) {
      return
    }
    try {
      linkSync(stagePath, targetPath)
    } catch (error) {
      if (quarantinePath && !isAlreadyExistsError(error)) {
        restoreRegularProfileOverlayQuarantine(quarantinePath, targetPath, fileName)
      }
      const reason = isAlreadyExistsError(error)
        ? 'Skipped profile config overlay publish to preserve a concurrent target:'
        : 'Failed to publish profile config overlay:'
      console.warn('[codex-config]', reason, fileName, error)
      return
    }
    if (quarantinePath) {
      removeProfileOverlayQuarantine(quarantinePath, fileName)
    }
  } finally {
    removeActiveOverlayStage(stagePath, fileName)
  }
}

function canPublishProfileOverlayByHardLink(
  stagePath: string,
  targetPath: string,
  fileName: string
): boolean {
  const probePath = profileOverlayProbePath(targetPath)
  try {
    linkSync(stagePath, probePath)
  } catch (error) {
    console.warn(
      '[codex-config] Profile config overlay hard-link preflight failed:',
      fileName,
      error
    )
    return false
  }
  try {
    unlinkSync(probePath)
  } catch (error) {
    console.warn(
      '[codex-config] Failed to remove profile config overlay hard-link probe:',
      fileName,
      probePath,
      error
    )
    removeActiveOverlayProbe(probePath, fileName)
    return false
  }
  return true
}

export function quarantineProfileOverlayTarget(
  targetPath: string,
  fileName: string
): string | null | undefined {
  const quarantinePath = uniqueOverlaySiblingPath(targetPath, 'quarantine', 'hold')
  try {
    renameSync(targetPath, quarantinePath)
  } catch (error) {
    if (isNotFoundError(error)) {
      return null
    }
    console.warn('[codex-config] Failed to quarantine profile config overlay:', fileName, error)
    return undefined
  }

  let metadata: Stats
  try {
    metadata = lstatSync(quarantinePath)
  } catch (error) {
    console.warn(
      '[codex-config] Failed to inspect quarantined profile config overlay:',
      fileName,
      error
    )
    return undefined
  }
  if (!metadata.isFile()) {
    // The target can change type after the initial lstat. Retaining it avoids
    // cross-platform symlink dereference or directory reconstruction.
    warnRetainedQuarantine(
      fileName,
      quarantinePath,
      new Error('Quarantined profile overlay is not a regular file')
    )
    return undefined
  }
  return quarantinePath
}

export function restoreRegularProfileOverlayQuarantine(
  quarantinePath: string,
  targetPath: string,
  fileName: string
): void {
  try {
    // EEXIST leaves both a concurrent target and the quarantine untouched.
    linkSync(quarantinePath, targetPath)
  } catch (error) {
    warnRetainedQuarantine(fileName, quarantinePath, error)
    return
  }
  removeProfileOverlayQuarantine(quarantinePath, fileName)
}

export function removeProfileOverlayQuarantine(quarantinePath: string, fileName: string): void {
  try {
    unlinkSync(quarantinePath)
  } catch (error) {
    // If restore already linked the target, both names still reference the
    // same file, so retaining the quarantine remains recoverable.
    warnRetainedQuarantine(fileName, quarantinePath, error)
  }
}

export function lstatProfileOverlayIfExists(filePath: string): Stats | null {
  try {
    return lstatSync(filePath)
  } catch (error) {
    if (isNotFoundError(error)) {
      return null
    }
    throw error
  }
}

function removeActiveOverlayStage(stagePath: string, fileName: string): void {
  try {
    unlinkSync(stagePath)
  } catch (error) {
    if (!isNotFoundError(error)) {
      console.warn(
        '[codex-config] Failed to remove profile overlay stage:',
        fileName,
        stagePath,
        error
      )
    }
  }
}

function removeActiveOverlayProbe(probePath: string, fileName: string): void {
  try {
    unlinkSync(probePath)
  } catch (error) {
    if (!isNotFoundError(error)) {
      console.warn('[codex-config] Retained profile overlay hard-link probe:', fileName, probePath)
    }
  }
}

function warnRetainedQuarantine(fileName: string, quarantinePath: string, reason: unknown): void {
  console.warn(
    '[codex-config] Retained profile overlay quarantine for manual recovery:',
    fileName,
    quarantinePath,
    reason
  )
}

function profileOverlayProbePath(targetPath: string): string {
  // Why: persistent unlink denial must cap retained probes at one per target.
  return join(dirname(targetPath), `.orca-profile-overlay-probe-${basename(targetPath)}.tmp`)
}

function uniqueOverlaySiblingPath(
  targetPath: string,
  role: 'quarantine' | 'stage',
  extension: string
): string {
  return join(
    dirname(targetPath),
    `.orca-profile-overlay-${role}-${process.pid}-${randomUUID()}.${extension}`
  )
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  )
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
