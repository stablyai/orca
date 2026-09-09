import type { GitStashCreateOptions, GitStashFile, GitStashMutationTarget, GitStashSummary } from '../../shared/git-stash'
import { isFullGitObjectId, isGitStashRef, parseGitStashFiles, parseGitStashList } from '../../shared/git-stash'
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
  target: GitStashMutationTarget,
  options: GitRuntimeOptions & { signal?: AbortSignal } = {}
): Promise<GitStashFile[]> {
  const stashRef = requireStashRef(target.ref)
  if (!isFullGitObjectId(target.expectedCommitId)) {
    throw new Error('invalid_stash_revision')
  }
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
  if (stashCommit.toLowerCase() !== target.expectedCommitId.toLowerCase()) {
    throw new Error('stash_revision_changed')
  }
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

async function verifyStashTarget(
  worktreePath: string,
  target: GitStashMutationTarget,
  options: GitRuntimeOptions
): Promise<string> {
  const ref = requireStashRef(target.ref)
  if (!isFullGitObjectId(target.expectedCommitId)) {
    throw new Error('invalid_stash_revision')
  }
  const { stdout } = await gitExecFileAsync(
    ['rev-parse', '--verify', `${ref}^{commit}`, '--'],
    gitOptionsForWorktree(worktreePath, options)
  )
  if (stdout.trim().toLowerCase() !== target.expectedCommitId.toLowerCase()) {
    throw new Error('stash_revision_changed')
  }
  return ref
}

export async function applyStash(worktreePath: string, target: GitStashMutationTarget, options: GitRuntimeOptions = {}): Promise<void> {
  await verifyStashTarget(worktreePath, target, options)
  await gitExecFileAsync(
    ['stash', 'apply', target.expectedCommitId],
    gitOptionsForWorktree(worktreePath, options)
  )
}

export async function popStash(worktreePath: string, target: GitStashMutationTarget, options: GitRuntimeOptions = {}): Promise<void> {
  await verifyStashTarget(worktreePath, target, options)
  await gitExecFileAsync(
    ['stash', 'apply', target.expectedCommitId],
    gitOptionsForWorktree(worktreePath, options)
  )
  const ref = await verifyStashTarget(worktreePath, target, options)
  await gitExecFileAsync(['stash', 'drop', ref], gitOptionsForWorktree(worktreePath, options))
}

export async function dropStash(worktreePath: string, target: GitStashMutationTarget, options: GitRuntimeOptions = {}): Promise<void> {
  const ref = await verifyStashTarget(worktreePath, target, options)
  await gitExecFileAsync(['stash', 'drop', ref], gitOptionsForWorktree(worktreePath, options))
}
