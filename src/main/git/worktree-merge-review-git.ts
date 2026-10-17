/**
 * Git plumbing shared by the merge-review operations: a runner that reports
 * Git's own stderr instead of a generic failure, the small probes the flow asks
 * about a checkout, the stash it parks there, and the temp-index snapshot of a
 * worktree's uncommitted changes.
 */
import { access, copyFile, mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  WORKTREE_MERGE_REVIEW_STASH_MARKER,
  findWorktreeMergeReviewStashRef,
  parseUnstagedWorktreePaths,
  worktreeMergeReviewSnapshotMessage
} from '../../shared/git-merge-review'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { extractExecError } from './exec-error'
import { gitExecFileAsync } from './runner'
import { detectConflictOperation } from './source-control/git-conflict-operation'
import { resolveGitDir } from './source-control/resolve-git-dir'

export type WorktreeMergeReviewGitOptions = Pick<GitRuntimeOptions, 'wslDistro'>

export type MergeReviewGit = ReturnType<typeof createMergeReviewGit>

export function createMergeReviewGit(cwd: string, options: WorktreeMergeReviewGitOptions) {
  const base = { ...gitOptionsForWorktree(cwd, options), admissionTier: 'interactive' as const }
  const exec = (args: string[], env?: NodeJS.ProcessEnv) =>
    gitExecFileAsync(args, env ? { ...base, env } : base)

  return {
    /** Trimmed stdout; rejects with Git's own stderr so the user sees the real cause. */
    output: async (args: string[], env?: NodeJS.ProcessEnv): Promise<string> => {
      try {
        return (await exec(args, env)).stdout.trimEnd()
      } catch (error) {
        throw new Error(extractExecError(error).stderr.trim() || `git ${args[0]} failed`)
      }
    },
    /** Non-zero exits are values here: several Git probes answer through the exit code. */
    attempt: async (args: string[], env?: NodeJS.ProcessEnv) => {
      try {
        const { stdout, stderr } = await exec(args, env)
        return { ok: true, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
      } catch (error) {
        const { stdout, stderr } = extractExecError(error)
        return { ok: false, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
      }
    }
  }
}

export function lines(text: string): string[] {
  return text ? text.split('\n').filter(Boolean) : []
}

export function indent(items: readonly string[]): string {
  return items.map((item) => `  ${item}`).join('\n')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export async function isMergePending(
  mainWorktreePath: string,
  options: WorktreeMergeReviewGitOptions
): Promise<boolean> {
  return (await detectConflictOperation(mainWorktreePath, options)) === 'merge'
}

export async function currentBranch(git: MergeReviewGit): Promise<string | null> {
  const result = await git.attempt(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return result.ok && result.stdout ? result.stdout : null
}

export async function unmergedFiles(git: MergeReviewGit): Promise<string[]> {
  return lines(await git.output(['diff', '--name-only', '--diff-filter=U']))
}

/** Tracked paths with any staged or unstaged change (untracked files excluded). */
export async function trackedChanges(git: MergeReviewGit): Promise<string[]> {
  return lines(await git.output(['status', '--porcelain', '--untracked-files=no']))
}

/** Changes made in the main checkout *around* the merge: unresolved conflicts and unstaged edits. */
export async function collectHandEdits(git: MergeReviewGit): Promise<string[]> {
  const [conflicts, unstaged] = await Promise.all([
    unmergedFiles(git),
    git
      .output(['status', '--porcelain', '-z', '--untracked-files=no'])
      .then(parseUnstagedWorktreePaths)
  ])
  return [...new Set([...conflicts, ...unstaged])]
}

async function findStash(git: MergeReviewGit): Promise<string | null> {
  return findWorktreeMergeReviewStashRef(await git.output(['stash', 'list', '--format=%gd%x00%gs']))
}

export async function hasParkedStash(git: MergeReviewGit): Promise<boolean> {
  return (await findStash(git)) !== null
}

/** Restores the main checkout's parked changes; false when none were parked. */
export async function restoreStash(git: MergeReviewGit): Promise<boolean> {
  const ref = await findStash(git)
  if (!ref) {
    return false
  }
  const result = await git.attempt(['stash', 'pop', ref])
  if (result.ok) {
    return true
  }
  const kept = (await findStash(git)) ?? ref
  const conflicts = await unmergedFiles(git)
  if (conflicts.length > 0) {
    throw new Error(
      `Restoring the main checkout's parked changes conflicted:\n${indent(conflicts)}\n` +
        `Resolve them there, then run \`git stash drop ${kept}\` — the stash is kept at ${kept}.`
    )
  }
  throw new Error(
    `Restoring the main checkout's parked changes failed (stash kept at ${kept}):\n${result.stderr || result.stdout}`
  )
}

export async function parkMainChanges(git: MergeReviewGit, branch: string): Promise<void> {
  await git.output([
    'stash',
    'push',
    '-m',
    `${WORKTREE_MERGE_REVIEW_STASH_MARKER}: auto-stash before syncing ${branch}`
  ])
}

/**
 * Temporary commit holding the worktree's uncommitted changes (tracked and
 * untracked), built against a private copy of the index so the worktree itself
 * is never touched. Returns null when the worktree has nothing uncommitted.
 */
export async function snapshotUncommittedChanges(
  git: MergeReviewGit,
  worktreePath: string,
  options: WorktreeMergeReviewGitOptions,
  branch: string
): Promise<string | null> {
  const indexSource = path.join(await resolveGitDir(worktreePath, options), 'index')
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orca-merge-review-'))
  try {
    const tempIndex = path.join(tempDir, 'index')
    if (await pathExists(indexSource)) {
      await copyFile(indexSource, tempIndex)
    }
    const env = { GIT_INDEX_FILE: tempIndex }
    await git.output(['add', '-A'], env)
    const tree = await git.output(['write-tree'], env)
    if (tree === (await git.output(['rev-parse', 'HEAD^{tree}']))) {
      return null
    }
    return git.output([
      'commit-tree',
      tree,
      '-p',
      'HEAD',
      '-m',
      worktreeMergeReviewSnapshotMessage(branch)
    ])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
