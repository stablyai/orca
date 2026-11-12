import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import { gitOptionalLocksDisabledEnv } from '../command-runner/git-environment/git-process-env'
import { literalPathspec } from './git-pathspec'

export async function readGitlinkOidFromTree(
  worktreePath: string,
  ref: string,
  submodulePath: string,
  options: GitRuntimeOptions
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['ls-tree', ref, '--', literalPathspec(submodulePath, worktreePath, options)],
      {
        ...gitOptionsForWorktree(worktreePath, options),
        env: gitOptionalLocksDisabledEnv()
      }
    )
    return stdout.match(/^160000 commit ([0-9a-f]+)\t/m)?.[1] ?? ''
  } catch {
    return ''
  }
}

export async function readGitlinkOidFromIndex(
  worktreePath: string,
  submodulePath: string,
  options: GitRuntimeOptions
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['ls-files', '-s', '--', literalPathspec(submodulePath, worktreePath, options)],
      {
        ...gitOptionsForWorktree(worktreePath, options),
        env: gitOptionalLocksDisabledEnv()
      }
    )
    return stdout.match(/^160000 ([0-9a-f]+) /m)?.[1] ?? ''
  } catch {
    return ''
  }
}

export async function readWorkingSubmoduleHead(
  submoduleWorktreePath: string,
  options: GitRuntimeOptions
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', 'HEAD'], {
      ...gitOptionsForWorktree(submoduleWorktreePath, options),
      env: gitOptionalLocksDisabledEnv()
    })
    return stdout.trim()
  } catch {
    return ''
  }
}
