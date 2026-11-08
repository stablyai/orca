import { link, rename, rm } from 'node:fs/promises'

export type CodexRolloutHardlinkOutcome = 'linked' | 'existing' | 'unsupported' | 'failed'

// Codex resume ignores symlinked rollouts; hardlinks keep one resumable log.
export async function tryHardlinkCodexRollout(
  sourcePath: string,
  targetPath: string
): Promise<CodexRolloutHardlinkOutcome> {
  try {
    await link(sourcePath, targetPath)
    return 'linked'
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      // A concurrent pass created it after the listing.
      return 'existing'
    }
    if (isUnsupportedHardlinkError(error)) {
      return 'unsupported'
    }
    // Permission and I/O errors stay retryable rather than becoming a permanent symlink.
    console.warn('[codex-rollout-hardlink] Failed to hardlink Codex session:', sourcePath, error)
    return 'failed'
  }
}

/** Swaps a symlinked rollout for a hardlink to the same source without a moment of absence. */
export async function replaceCodexRolloutSymlinkWithHardlink(
  sourcePath: string,
  symlinkPath: string
): Promise<'replaced' | 'unsupported' | 'failed'> {
  const replacementPath = `${symlinkPath}.orca-link-${process.pid}`
  await rm(replacementPath, { force: true })
  const hardlink = await tryHardlinkCodexRollout(sourcePath, replacementPath)
  if (hardlink === 'unsupported') {
    return 'unsupported'
  }
  if (hardlink !== 'linked') {
    return 'failed'
  }
  try {
    await rename(replacementPath, symlinkPath)
    return 'replaced'
  } catch (error) {
    console.warn(
      '[codex-rollout-hardlink] Failed to replace symlinked rollout:',
      symlinkPath,
      error
    )
    await rm(replacementPath, { force: true })
    return 'failed'
  }
}

/** The filesystem pair cannot hold a hardlink at all; anything else may succeed on retry. */
export function isUnsupportedHardlinkError(error: unknown): boolean {
  return ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].some((code) => hasErrorCode(error, code))
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
