import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'

export async function resolveCompareRef(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(['branch', '--show-current'], {
      ...gitOptionsForWorktree(worktreePath, options)
    })
    const branch = stdout.trim()
    return branch || 'HEAD'
  } catch {
    return 'HEAD'
  }
}

export async function resolveRefOid(
  worktreePath: string,
  ref: string,
  options: GitRuntimeOptions = {}
): Promise<string> {
  const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', '--end-of-options', ref], {
    ...gitOptionsForWorktree(worktreePath, options)
  })
  return stdout.trim()
}

export async function resolveMergeBase(
  worktreePath: string,
  baseOid: string,
  headOid: string,
  options: GitRuntimeOptions = {}
): Promise<string> {
  const { stdout } = await gitExecFileAsync(['merge-base', baseOid, headOid], {
    ...gitOptionsForWorktree(worktreePath, options)
  })
  return stdout.trim()
}

export async function countAheadCommits(
  worktreePath: string,
  baseOid: string,
  headOid: string,
  options: GitRuntimeOptions = {}
): Promise<number> {
  const { stdout } = await gitExecFileAsync(['rev-list', '--count', `${baseOid}..${headOid}`], {
    ...gitOptionsForWorktree(worktreePath, options)
  })
  return Number.parseInt(stdout.trim(), 10) || 0
}
