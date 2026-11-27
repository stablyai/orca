import { randomUUID } from 'node:crypto'
import { link, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import {
  clearDarwinFileFlags,
  removeStagedCopy,
  stageRolloutCopy
} from './codex-rollout-staged-copy'

const HARDLINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

export class AtomicNoReplaceUnsupportedError extends Error {
  constructor(targetPath: string, cause: unknown) {
    super(`Cannot publish a rollout copy without overwrite on this filesystem: ${targetPath}`, {
      cause
    })
    this.name = 'AtomicNoReplaceUnsupportedError'
  }
}

/** Whether a `link()` failed because the filesystem has no hard links. */
export function isHardLinkUnsupportedError(error: unknown): boolean {
  const code = errnoCodeOrUnknown(error)
  // Windows reports CreateHardLinkW's ERROR_INVALID_FUNCTION (FAT, exFAT) as EISDIR.
  return HARDLINK_UNSUPPORTED_CODES.has(code) || (process.platform === 'win32' && code === 'EISDIR')
}

/**
 * Publishes a staged copy under the rollout's name with a hard link, which never replaces a
 * file already there (`existing`). Throws `AtomicNoReplaceUnsupportedError` where links are refused.
 */
export async function linkStagedRollout(
  temporaryPath: string,
  targetPath: string
): Promise<'copied' | 'existing'>
/** `stillWanted` is checked again before a retry, which follows an awaited flag clear: `refused` once it fails. */
export async function linkStagedRollout(
  temporaryPath: string,
  targetPath: string,
  stillWanted: () => boolean
): Promise<'copied' | 'existing' | 'refused'>
export async function linkStagedRollout(
  temporaryPath: string,
  targetPath: string,
  stillWanted?: () => boolean
): Promise<'copied' | 'existing' | 'refused'> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await link(temporaryPath, targetPath)
      return 'copied'
    } catch (error) {
      const code = errnoCodeOrUnknown(error)
      if (code === 'EEXIST') {
        return 'existing'
      }
      // A macOS clone keeps a locked or append-only source's flags, which refuse the link.
      if (
        process.platform === 'darwin' &&
        attempt === 0 &&
        code === 'EPERM' &&
        (await clearDarwinFileFlags(temporaryPath))
      ) {
        if (stillWanted && !stillWanted()) {
          return 'refused'
        }
        continue
      }
      // Node has no portable atomic rename-if-absent; refuse filesystems without hard links.
      throw isHardLinkUnsupportedError(error)
        ? new AtomicNoReplaceUnsupportedError(targetPath, error)
        : error
    }
  }
}

/**
 * Copies a rollout to `targetPath` through a staged non-rollout name, so readers never see a
 * partial file, and never replaces one already there (`existing`).
 */
export async function copyCodexRolloutWithoutOverwrite(
  sourcePath: string,
  targetPath: string
): Promise<'copied' | 'existing'> {
  const temporaryPath = join(dirname(targetPath), `.orca-backfill-${randomUUID()}.tmp`)
  const source = await stat(sourcePath, { bigint: true })
  try {
    await stageRolloutCopy(source, sourcePath, temporaryPath)
    return await linkStagedRollout(temporaryPath, targetPath)
  } finally {
    try {
      await removeStagedCopy(temporaryPath)
    } catch (error) {
      // Codex ignores .tmp files; cleanup failure must not invalidate a successful publication.
      console.warn('[codex-rollout-copy] Failed to remove staged copy:', temporaryPath, error)
    }
  }
}
