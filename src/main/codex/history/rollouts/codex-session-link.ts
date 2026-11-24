import { linkSync, symlinkSync } from 'node:fs'
import { link, symlink } from 'node:fs/promises'
import {
  isCodexRolloutHeldForDeletion,
  linkCodexRolloutUnlessHeld
} from './codex-rollout-deletion-guard'

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function hardlinkCodexSessionFile(
  sourcePath: string,
  targetPath: string
): 'linked' | 'source-missing' | 'failed' {
  if (isCodexRolloutHeldForDeletion(sourcePath)) {
    return 'failed'
  }
  try {
    // Codex resume ignores symlinked JSONL sessions; hardlinks keep one resumable log.
    linkSync(sourcePath, targetPath)
    return 'linked'
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'source-missing' : 'failed'
  }
}

export function tryHardlinkCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  return hardlinkCodexSessionFile(sourcePath, targetPath) === 'linked'
}

export function linkCodexSessionFile(sourcePath: string, targetPath: string): boolean {
  const hardlink = hardlinkCodexSessionFile(sourcePath, targetPath)
  // A held source, or one deleted since it was listed, must not get a (dangling) symlink.
  if (hardlink !== 'failed' || isCodexRolloutHeldForDeletion(sourcePath)) {
    return hardlink === 'linked'
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
  const outcome = await linkCodexRolloutUnlessHeld(sourcePath, () =>
    linkOrSymlink(sourcePath, targetPath, options)
  )
  return outcome === 'held' ? 'failed' : outcome
}

async function linkOrSymlink(
  sourcePath: string,
  targetPath: string,
  options: { hardlinkOnly: boolean }
): Promise<'linked' | 'existing' | 'skipped' | 'failed'> {
  try {
    await link(sourcePath, targetPath)
    return 'linked'
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') {
      return 'existing'
    }
    // A source deleted since it was listed would leave a dangling symlink.
    if (code === 'ENOENT') {
      return 'failed'
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
