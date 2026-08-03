import { stat } from 'node:fs/promises'

/**
 * True only when the directory is genuinely gone.
 *
 * A permission error means the path exists and cannot be read, which is not
 * the same thing. Callers use this to decide whether a workspace was deleted,
 * and treating EACCES as "deleted" would both mislabel a live service and
 * widen what the stop path is allowed to kill.
 */
export async function isMissingDirectory(target: string): Promise<boolean> {
  try {
    await stat(target)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}
