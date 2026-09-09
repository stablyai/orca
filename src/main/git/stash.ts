import type { GitStashCreateOptions, GitStashFile, GitStashSummary } from '../../shared/git-stash'
import { isGitStashRef, parseGitStashFiles, parseGitStashList } from '../../shared/git-stash'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

function requireStashRef(ref: string): string {
  if (!isGitStashRef(ref)) {
    throw new Error('Invalid stash reference')
  }
  return ref
}

export async function listStashes(
  worktreePath: string,
  options: GitRuntimeOptions & { signal?: AbortSignal } = {}
): Promise<GitStashSummary[]> {
  const { stdout } = await gitExecFileAsync(
    ['stash', 'list', '--format=%gd%x00%H%x00%an%x00%ae%x00%at%x00%s'],
    { ...gitOptionsForWorktree(worktreePath, options), signal: options.signal }
  )
  return parseGitStashList(stdout)
}

export async function createStash(
  worktreePath: string,
  stashOptions: GitStashCreateOptions,
  options: GitRuntimeOptions = {}
): Promise<void> {
  const args = ['stash', 'push']
  if (stashOptions.includeUntracked) {
    args.push('--include-untracked')
  }
  if (stashOptions.keepIndex) {
    args.push('--keep-index')
  }
  if (stashOptions.message?.trim()) {
    args.push('--message', stashOptions.message.trim())
  }
  await gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
}

export async function listStashFiles(
  worktreePath: string,
  ref: string,
  options: GitRuntimeOptions & { signal?: AbortSignal } = {}
): Promise<GitStashFile[]> {
  const stashRef = requireStashRef(ref)
  const runtimeOptions = {
    ...gitOptionsForWorktree(worktreePath, options),
    signal: options.signal
  }
  const { stdout: revisionLine } = await gitExecFileAsync(
    ['rev-list', '--parents', '-n', '1', stashRef, '--'],
    runtimeOptions
  )
  const [stashCommit = '', trackedParent = '', , untrackedCommit] = revisionLine
    .trim()
    .split(/\s+/)
  const { stdout: trackedOutput } = await gitExecFileAsync(
    ['diff', '--name-status', '-z', trackedParent, stashCommit, '--'],
    runtimeOptions
  )
  const tracked = parseGitStashFiles(trackedOutput).map((file) => ({
    ...file,
    commitId: stashCommit
  }))
  if (!untrackedCommit) {
    return tracked
  }
  const { stdout: untrackedOutput } = await gitExecFileAsync(
    [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-z',
      untrackedCommit,
      '--'
    ],
    runtimeOptions
  )
  return [
    ...tracked,
    ...parseGitStashFiles(untrackedOutput).map((file) => ({
      ...file,
      commitId: untrackedCommit
    }))
  ].slice(0, 2000)
}

export async function applyStash(worktreePath: string, ref: string, options: GitRuntimeOptions = {}): Promise<void> {
  await gitExecFileAsync(['stash', 'apply', requireStashRef(ref)], gitOptionsForWorktree(worktreePath, options))
}

export async function popStash(worktreePath: string, ref: string, options: GitRuntimeOptions = {}): Promise<void> {
  await gitExecFileAsync(['stash', 'pop', requireStashRef(ref)], gitOptionsForWorktree(worktreePath, options))
}

export async function dropStash(worktreePath: string, ref: string, options: GitRuntimeOptions = {}): Promise<void> {
  await gitExecFileAsync(['stash', 'drop', requireStashRef(ref)], gitOptionsForWorktree(worktreePath, options))
}
