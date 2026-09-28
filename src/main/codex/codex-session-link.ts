import {
  constants,
  copyFileSync,
  linkSync,
  mkdtempSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'

/**
 * Attempts a hardlink so resume sees one physical JSONL session log.
 */
export function tryHardlinkCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  try {
    // Why: Codex resume ignores symlinked JSONL sessions, while a hardlink
    // preserves one physical log without copy divergence.
    linkSync(sourcePath, targetPath)
    return true
  } catch {
    return false
  }
}

/**
 * Attempts a copy so resume sees a real JSONL session log when hardlink fails
 * (e.g. cross-volume EXDEV, non-elevated Windows without symlink privilege, or restrictive filesystems).
 */
export function tryCopyCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  let temporaryDirectory: string | undefined
  try {
    temporaryDirectory = mkdtempSync(`${targetPath}.`)
    const temporaryPath = join(temporaryDirectory, 'rollout.tmp')
    copyFileSync(sourcePath, temporaryPath, constants.COPYFILE_EXCL)
    // Publish the complete copy without replacing a concurrent bridge or divergent history.
    linkSync(temporaryPath, targetPath)
    return true
  } catch {
    return false
  } finally {
    if (temporaryDirectory) {
      try {
        unlinkSync(join(temporaryDirectory, 'rollout.tmp'))
      } catch {
        /* Copy may have failed. */
      }
      try {
        rmdirSync(temporaryDirectory)
      } catch {
        /* Preserve unexpected contents. */
      }
    }
  }
}

/**
 * Links a session file with hardlink first and symlink fallback.
 */
export function linkCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  if (tryHardlinkCodexSessionFile(sourcePath, targetPath)) {
    return true
  }
  try {
    // Why fallback: hardlinks keep sessions visible to Codex resume, but can
    // fail across volumes. A symlink is still better than a diverging copy.
    symlinkSync(sourcePath, targetPath, process.platform === 'win32' ? 'file' : undefined)
    return true
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to link Codex session:', sourcePath, error)
  }
  return false
}
