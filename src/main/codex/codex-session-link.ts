import { linkSync, symlinkSync } from 'node:fs'

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
