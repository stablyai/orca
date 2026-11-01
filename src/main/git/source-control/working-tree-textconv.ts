import { readFile, stat } from 'node:fs/promises'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree, gitReadOptionsForWorktree } from '../git-runtime-options'
import { createLocalGitObjectQuarantine } from '../local-git-object-quarantine'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from '../runner'
import { isImageOrPdfPreviewPath } from './git-blob-read'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'

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
  if (isImageOrPdfPreviewPath(filePath)) {
    return false
  }
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const driver = await readTextconvDriver(worktreePath, gitPath, options)
    if (!driver) {
      return false
    }
    const fileStat = await stat(hostFilePath)
    if (!fileStat.isFile() || fileStat.size > MAX_GIT_SHOW_BYTES) {
      return false
    }
    const raw = await readFile(hostFilePath)
    // Hashing the file runs its clean filter, as `git diff` does; keep the object out of the repo.
    const quarantine = createLocalGitObjectQuarantine(worktreePath, options)
    const converted = await quarantine.run(async (env) => {
      if (!env) {
        return undefined
      }
      const { stdout: oid } = await gitExecFileAsync(
        ['hash-object', '-w', `--path=${gitPath}`, '--', gitPath],
        { ...gitOptionsForWorktree(worktreePath, options), env }
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

async function readTextconvDriver(
  worktreePath: string,
  gitPath: string,
  options: GitRuntimeOptions
): Promise<string | undefined> {
  const readOptions = gitReadOptionsForWorktree(worktreePath, options)
  const { stdout } = await gitExecFileAsync(
    ['check-attr', '-z', 'diff', '--', gitPath],
    readOptions
  )
  // -z output is `<path>\0diff\0<value>\0`; set/unset/unspecified name no driver.
  const driver = stdout.split('\0')[2]
  if (!driver || driver === 'set' || driver === 'unset' || driver === 'unspecified') {
    return undefined
  }
  try {
    const { stdout: textconv } = await gitExecFileAsync(
      ['config', '--get', `diff.${driver}.textconv`],
      readOptions
    )
    return textconv.trim() ? driver : undefined
  } catch {
    // `git config --get` exits 1 when the driver has no textconv.
    return undefined
  }
}
