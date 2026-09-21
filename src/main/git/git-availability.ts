import { access } from 'node:fs/promises'
import { isMissingCommandBinaryError } from './exec-error'

type GitVersionExec = (
  args: string[],
  options: { cwd: string; timeout: number }
) => Promise<unknown>

/**
 * Resolves `false` only when the spawn proved Git absent; every other failure rejects so callers
 * keep an unknown answer instead of reporting a host with no Git.
 */
export async function probeGitAvailability(
  exec: GitVersionExec,
  options: { cwd: string; timeout: number }
): Promise<boolean> {
  try {
    await exec(['--version'], options)
    return true
  } catch (err) {
    if (isMissingCommandBinaryError(err)) {
      try {
        await access(options.cwd)
        return false
      } catch {
        // Node reports the same spawn ENOENT for a missing binary and a missing cwd.
      }
    }
    throw err
  }
}
