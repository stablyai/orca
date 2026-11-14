import { randomUUID } from 'node:crypto'
import { copyFile, link, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ATOMIC_NO_REPLACE_UNSUPPORTED_CODE = 'ORCA_ATOMIC_NO_REPLACE_UNSUPPORTED'

export async function copySessionFileWithoutOverwrite(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  const temporaryPath = join(dirname(targetPath), `.orca-backfill-${randomUUID()}.tmp`)
  // Stage away from the rollout name so retries cannot mistake a partial copy for a complete session.
  await writeFile(temporaryPath, '', { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
  try {
    await copyFile(sourcePath, temporaryPath)
    try {
      // A same-volume hardlink publishes atomically without replacing a concurrent target.
      await link(temporaryPath, targetPath)
    } catch (installLinkError) {
      if (isExistsError(installLinkError)) {
        throw installLinkError
      }
      if (!isHardlinkUnsupportedError(installLinkError)) {
        throw installLinkError
      }
      // Node has no portable atomic rename-if-absent; refuse filesystems without hardlinks.
      throw makeAtomicNoReplaceUnsupportedError(targetPath, installLinkError)
    }
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch (error) {
      // Codex ignores .tmp files; cleanup failure must not invalidate a successful publication.
      console.warn('[codex-session-backfill] Failed to remove staged copy:', temporaryPath, error)
    }
  }
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

function isHardlinkUnsupportedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'ENOSYS'
  )
}

function makeAtomicNoReplaceUnsupportedError(
  targetPath: string,
  cause: unknown
): NodeJS.ErrnoException {
  const error = new Error(
    `Cannot atomically install backfill without overwrite on this filesystem: ${targetPath}`,
    { cause }
  ) as NodeJS.ErrnoException
  error.code = ATOMIC_NO_REPLACE_UNSUPPORTED_CODE
  return error
}

export function isAtomicNoReplaceUnsupportedError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === ATOMIC_NO_REPLACE_UNSUPPORTED_CODE
}
