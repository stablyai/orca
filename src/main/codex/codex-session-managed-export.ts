import { linkSync, lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'

export type ManagedCodexSessionExportResult =
  | 'linked'
  | 'already-linked'
  | 'collision'
  | 'failed'
  | 'ignored'

/**
 * Publishes one managed Codex transcript into the user's external history.
 *
 * Hardlinks keep concurrent appends coherent. Cross-volume copies and symlinks
 * are intentionally rejected because they either diverge or are ignored by
 * Codex resume.
 */
export function exportManagedCodexSessionToSystemHistory(
  managedSessionFilePath: string,
  systemCodexHomePath = getSystemCodexHomePath()
): ManagedCodexSessionExportResult {
  const managedSessionsRoot = join(getOrcaManagedCodexHomePath(), 'sessions')
  const relativeSessionPath = resolveManagedSessionRelativePath(
    managedSessionsRoot,
    managedSessionFilePath
  )
  if (!relativeSessionPath) {
    return 'ignored'
  }

  const systemSessionsRoot = join(systemCodexHomePath, 'sessions')
  const systemSessionFilePath = join(systemSessionsRoot, relativeSessionPath)
  const existingTarget = tryLstat(systemSessionFilePath)
  if (existingTarget) {
    if (sameFileIdentity(tryLstat(managedSessionFilePath), existingTarget)) {
      return 'already-linked'
    }
    // Why: a relative-path collision can represent two independent sessions;
    // overwriting either history would turn a visibility fix into data loss.
    console.warn('[codex-session-bridge] Managed session export collision:', {
      managedSessionFilePath,
      systemSessionFilePath
    })
    return 'collision'
  }

  if (!prepareSafeSystemTargetDirectory(systemSessionsRoot, dirname(systemSessionFilePath))) {
    return 'failed'
  }
  try {
    linkSync(managedSessionFilePath, systemSessionFilePath)
    return 'linked'
  } catch (error) {
    // Why: another bridge can win the create race after the preflight check.
    // Treat the resulting shared inode as success without replacing anything.
    if (sameFileIdentity(tryLstat(managedSessionFilePath), tryLstat(systemSessionFilePath))) {
      return 'already-linked'
    }
    console.warn('[codex-session-bridge] Failed to export managed Codex session:', {
      managedSessionFilePath,
      systemSessionFilePath,
      error
    })
    return 'failed'
  }
}

function resolveManagedSessionRelativePath(
  managedSessionsRoot: string,
  managedSessionFilePath: string
): string | null {
  const sourceStat = tryLstat(managedSessionFilePath)
  if (!sourceStat?.isFile() || !managedSessionFilePath.endsWith('.jsonl')) {
    return null
  }
  const canonicalRoot = tryRealpath(managedSessionsRoot)
  const canonicalSource = tryRealpath(managedSessionFilePath)
  if (!canonicalRoot || !canonicalSource) {
    return null
  }
  const relativePath = relative(canonicalRoot, canonicalSource)
  return isSafeRelativePath(relativePath) ? relativePath : null
}

function prepareSafeSystemTargetDirectory(
  systemSessionsRoot: string,
  targetDirectory: string
): boolean {
  try {
    mkdirSync(systemSessionsRoot, { recursive: true })
    const relativeTargetDirectory = relative(systemSessionsRoot, targetDirectory)
    if (relativeTargetDirectory && !isSafeRelativePath(relativeTargetDirectory)) {
      return false
    }
    let currentDirectory = systemSessionsRoot
    for (const segment of relativeTargetDirectory.split(sep).filter(Boolean)) {
      currentDirectory = join(currentDirectory, segment)
      const existingDirectory = tryLstat(currentDirectory)
      if (existingDirectory) {
        if (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink()) {
          console.warn('[codex-session-bridge] Refusing symlinked system history directory:', {
            currentDirectory
          })
          return false
        }
        continue
      }
      mkdirSync(currentDirectory)
    }
    const canonicalRoot = realpathSync.native(systemSessionsRoot)
    const canonicalTargetDirectory = realpathSync.native(targetDirectory)
    const canonicalRelativeTarget = relative(canonicalRoot, canonicalTargetDirectory)
    if (canonicalRelativeTarget === '' || isSafeRelativePath(canonicalRelativeTarget)) {
      return true
    }
    console.warn('[codex-session-bridge] Refusing session export outside system history root:', {
      systemSessionsRoot,
      targetDirectory
    })
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to prepare system Codex history:', {
      systemSessionsRoot,
      targetDirectory,
      error
    })
  }
  return false
}

function isSafeRelativePath(relativePath: string): boolean {
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

function sameFileIdentity(left: Stats | null, right: Stats | null): boolean {
  return !!left && !!right && left.ino !== 0 && left.dev === right.dev && left.ino === right.ino
}

function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}
