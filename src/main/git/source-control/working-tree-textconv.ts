import { readFile, stat } from 'node:fs/promises'
import { GIT_READ_TIMEOUT_MS } from '../../../shared/git-command-timeout'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree, gitReadOptionsForWorktree } from '../git-runtime-options'
import { createLocalGitObjectQuarantine } from '../local-git-object-quarantine'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from '../runner'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'
import { readTextconvDriver } from './textconv-driver'

/**
 * Whether an unstaged diff may show the Git side through the path's textconv driver.
 * The working-tree side is editable raw bytes, so this holds only when textconv leaves them
 * unchanged (clean/smudge encryption such as git-crypt); otherwise both sides stay raw.
 */
export async function workingTreeMatchesTextconv(
  worktreePath: string,
  filePath: string,
  hostFilePath: string,
  options: GitRuntimeOptions = {}
): Promise<boolean> {
  const gitPath = filePath.replace(/\\/g, '/')
  const driver = await readTextconvDriver(worktreePath, gitPath, options)
  if (!driver) {
    return false
  }
  let fileStat
  try {
    fileStat = await stat(hostFilePath)
  } catch (error) {
    // A deleted file leaves nothing editable, so the Git side can show converted text.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
  }
  if (!fileStat.isFile() || fileStat.size > MAX_GIT_SHOW_BYTES) {
    return false
  }
  try {
    const raw = await readFile(hostFilePath)
    // Hashing the file runs its clean filter, as `git diff` does; keep the object out of the repo.
    const quarantine = createLocalGitObjectQuarantine(worktreePath, options)
    const converted = await quarantine.run(async (env) => {
      if (!env) {
        return undefined
      }
      const { stdout: oid } = await gitExecFileAsync(
        ['hash-object', '-w', `--path=${gitPath}`, '--', gitPath],
        { ...gitOptionsForWorktree(worktreePath, options), env, timeout: GIT_READ_TIMEOUT_MS }
      )
      // The textconv cache would point a repo ref at the quarantined object.
      const { stdout } = await gitExecFileAsyncBuffer(
        [
          '-c',
          `diff.${driver}.cachetextconv=false`,
          'cat-file',
          '--textconv',
          `--path=${gitPath}`,
          oid.trim()
        ],
        { ...gitReadOptionsForWorktree(worktreePath, options), env, maxBuffer: MAX_GIT_SHOW_BYTES }
      )
      return stdout
    })
    return converted?.equals(raw) === true
  } catch {
    return false
  }
}
