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
import { isUnsupportedMergeTreeWriteTreeError } from '../../shared/git-merge-tree-capability'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { extractExecError } from './exec-error'
import { getLocalGitCapabilityCache } from './git-capability-state'
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

/** Changes made in the main checkout *around* the merge: unresolved conflicts,
 *  unstaged edits, and staged edits that differ from the merge's own result. */
export async function collectHandEdits(
  git: MergeReviewGit,
  worktreePath: string,
  options: WorktreeMergeReviewGitOptions
): Promise<string[]> {
  const [conflicts, unstaged, staged] = await Promise.all([
    unmergedFiles(git),
    git
      .output(['status', '--porcelain', '-z', '--untracked-files=no'])
      .then(parseUnstagedWorktreePaths),
    stagedEditsBeyondMerge(git, worktreePath, options)
  ])
  return [...new Set([...conflicts, ...unstaged, ...staged])]
}

/**
 * Staged paths whose content is not what this merge put there.
 *
 * Why the merge result tree: during `merge --no-commit` the index *is* the merge,
 * so every staged path looks like a hand edit unless it is compared against what
 * the merge would produce on its own. `merge --abort` (reset --merge) discards
 * staged changes, so a miss here is silent data loss.
 */
async function stagedEditsBeyondMerge(
  git: MergeReviewGit,
  worktreePath: string,
  options: WorktreeMergeReviewGitOptions
): Promise<string[]> {
  const capabilities = getLocalGitCapabilityCache({
    cwd: worktreePath,
    wslDistro: options.wslDistro
  })
  if (
    !capabilities.isKnownSupported('merge-tree-write-tree') &&
    !capabilities.shouldTry('merge-tree-write-tree')
  ) {
    return stagedEditsOutsideMergeFiles(git)
  }
  const result = await git.attempt([
    'merge-tree',
    '--write-tree',
    '--no-messages',
    'HEAD',
    'MERGE_HEAD'
  ])
  if (isUnsupportedMergeTreeWriteTreeError(result.stderr)) {
    capabilities.rememberUnsupported('merge-tree-write-tree')
    return stagedEditsOutsideMergeFiles(git)
  }
  // Why not gate on the exit code: a conflicted merge exits 1 but still prints
  // its result tree, whose conflicted blobs carry markers. A staged resolution
  // differs from those blobs, so the comparison still finds it.
  const tree = result.stdout.split('\n', 1)[0]?.trim() ?? ''
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    return stagedEditsOutsideMergeFiles(git)
  }
  capabilities.rememberSupported('merge-tree-write-tree')
  return stagedEditsBeyondTree(git, tree)
}

/** Baseline-compatible fallback: a staged path the merge cannot have touched is a hand edit. */
async function stagedEditsOutsideMergeFiles(git: MergeReviewGit): Promise<string[]> {
  const [staged, merged] = await Promise.all([
    git.output(['diff', '--cached', '--name-only', '-z', 'HEAD']),
    git.output(['diff', '--name-only', '-z', 'HEAD', 'MERGE_HEAD'])
  ])
  const mergeFiles = new Set(merged.split('\0').filter(Boolean))
  return staged.split('\0').filter((path) => path && !mergeFiles.has(path))
}

async function stagedEditsBeyondTree(git: MergeReviewGit, tree: string): Promise<string[]> {
  const [indexOutput, treeOutput] = await Promise.all([
    git.output(['ls-files', '-s', '-z']),
    git.output(['ls-tree', '-r', '-z', tree])
  ])
  const expected = parseTreeEntries(treeOutput)
  const actual = parseIndexEntries(indexOutput)
  return [...new Set([...expected.keys(), ...actual.keys()])].filter(
    (path) => expected.get(path) !== actual.get(path)
  )
}

/** "<mode> <type> <oid>\t<path>" records, keyed by path. */
function parseTreeEntries(output: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab === -1) {
      continue
    }
    const [mode, , oid] = record.slice(0, tab).split(' ')
    entries.set(record.slice(tab + 1), `${mode}:${oid}`)
  }
  return entries
}

/** "<mode> <oid> <stage>\t<path>" records; unmerged stages are already hand edits. */
function parseIndexEntries(output: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab === -1) {
      continue
    }
    const [mode, oid, stage] = record.slice(0, tab).split(' ')
    if (stage === '0') {
      entries.set(record.slice(tab + 1), `${mode}:${oid}`)
    }
  }
  return entries
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
    // Why spread: a caller-provided env replaces the child environment wholesale,
    // so the temp index must ride along with PATH/HOME and the user's GIT_* settings.
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex }
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
