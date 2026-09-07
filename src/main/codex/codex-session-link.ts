import { copyFileSync, linkSync, symlinkSync } from 'node:fs'

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
  try {
    copyFileSync(sourcePath, targetPath)
    return true
  } catch {
    return false
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
