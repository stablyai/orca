import { linkSync, symlinkSync } from 'node:fs'
import { link, symlink } from 'node:fs/promises'

export function tryHardlinkCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  try {
    // Codex resume ignores symlinked JSONL sessions; hardlinks keep one resumable log.
    linkSync(sourcePath, targetPath)
    return true
  } catch {
    return false
  }
}

export function linkCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  if (tryHardlinkCodexSessionFile(sourcePath, targetPath)) {
    return true
  }
  try {
    // Cross-volume hardlinks fail; symlinks still prevent copy divergence.
    symlinkSync(sourcePath, targetPath, process.platform === 'win32' ? 'file' : undefined)
    return true
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to link Codex session:', sourcePath, error)
  }
  return false
}

/** Async form for background passes; `existing` means another writer created the target first. */
export async function linkCodexSessionFileAsync(
  sourcePath: string,
  targetPath: string,
  options: { hardlinkOnly: boolean }
): Promise<'linked' | 'existing' | 'skipped' | 'failed'> {
  try {
    await link(sourcePath, targetPath)
    return 'linked'
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      return 'existing'
    }
  }
  if (options.hardlinkOnly) {
    // A symlink would be ignored by resume and dangle once its account goes.
    return 'skipped'
  }
  try {
    await symlink(sourcePath, targetPath, process.platform === 'win32' ? 'file' : undefined)
    return 'linked'
  } catch (error) {
    console.warn('[codex-session-bridge] Failed to link Codex session:', sourcePath, error)
    return 'failed'
  }
}
