// A checkpoint is a stash-like commit kept under refs/orca/checkpoints/: its tree is the working
// tree (tracked, plus untracked files .gitignore doesn't exclude), its first parent is HEAD and its
// second parent holds the staged tree. Writing one never touches HEAD, the branch, the user's index
// or the stash list.

import { z } from 'zod'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CheckpointGitOptions,
  type CheckpointRepo,
  CHECKPOINT_REF_ROOT,
  gitExitCode,
  resolveCommit,
  withTempIndex,
  WorktreeCheckpointError
} from './worktree-checkpoint-git'

const META_PREFIX = 'orca-checkpoint: '

export type WorktreeCheckpointKind = 'turn' | 'undo'

export type WorktreeCheckpointMeta = {
  v: 1
  kind: WorktreeCheckpointKind
  /** HEAD when the checkpoint was taken; null on an unborn branch. */
  head: string | null
  /** The staged tree; null while the index had unmerged entries. */
  indexTree: string | null
  createdAt: number
  /** Caller's own labels (session and turn ids), opaque to git. */
  labels?: Record<string, string>
}

export type WorktreeTree = {
  tree: string
  head: string | null
  indexTree: string | null
}

export type WorktreeCheckpoint = WorktreeCheckpointMeta & {
  ref: string
  commit: string
  tree: string
}

export type CaptureOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  /** Given the working tree's tree, returns ignored paths that must be saved too (restore uses it
   *  to keep a copy of every file it is about to overwrite). */
  forceInclude?: (tree: string) => Promise<string[]>
}

/** Untracked files above this are left out of snapshots (like ignored files): hashing them every
 *  turn would bloat the object store. A restore that would overwrite one still saves it first. */
export const CHECKPOINT_MAX_UNTRACKED_BYTES = 10 * 1024 * 1024

async function largeUntrackedPaths(
  repo: CheckpointRepo,
  options: CheckpointGitOptions,
  deadline: number | null
): Promise<string[]> {
  const out = await repo.git(['ls-files', '-o', '--exclude-standard', '-z'], options)
  const large: string[] = []
  for (const path of out.split('\0')) {
    if (deadline !== null && Date.now() > deadline) {
      throw new WorktreeCheckpointError('snapshot-failed', 'The snapshot ran out of time.')
    }
    const stat = path ? await lstat(join(repo.root, path)).catch(() => null) : null
    if (stat?.isFile() && stat.size > CHECKPOINT_MAX_UNTRACKED_BYTES) {
      large.push(path)
    }
  }
  return large
}

/** `add --ignore-errors` exits 1 after skipping files it couldn't read; everything else is in. */
async function addSkippingUnreadable(
  repo: CheckpointRepo,
  args: string[],
  options: CheckpointGitOptions
): Promise<void> {
  try {
    await repo.git(['add', '--ignore-errors', ...args], options)
  } catch (error) {
    if (gitExitCode(error) !== 1) {
      throw error
    }
  }
}

/** Writes the working tree's tree into the object store without recording a ref. */
export async function captureWorktreeTree(
  repo: CheckpointRepo,
  options: CaptureOptions = {}
): Promise<WorktreeTree> {
  // One deadline for the whole capture, not one per git command.
  const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs
  const run = (env?: Record<string, string>): CheckpointGitOptions => ({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(deadline === null ? {} : { timeoutMs: Math.max(1, deadline - Date.now()) }),
    ...(env ? { env } : {})
  })
  const head = await resolveCommit(repo, 'HEAD')
  const large = await largeUntrackedPaths(repo, run(), deadline)
  return withTempIndex(repo, true, async (env) => {
    let indexTree: string | null = null
    try {
      // The temp index is a byte copy of the user's, so this is exactly what they had staged.
      indexTree = (await repo.git(['write-tree'], run(env))).trim() || null
    } catch {
      indexTree = null
    }
    await addSkippingUnreadable(repo, ['-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      ...run(env),
      stdin: `${[':/', ...large.map((path) => `:(exclude,literal)${path}`)].join('\0')}\0`
    })
    let tree = (await repo.git(['write-tree'], run(env))).trim()
    const forced = options.forceInclude ? await options.forceInclude(tree) : []
    if (forced.length > 0) {
      await repo.git(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        ...run(env),
        stdin: `${forced.map(literalPathspec).join('\0')}\0`
      })
      tree = (await repo.git(['write-tree'], run(env))).trim()
    }
    if (!tree) {
      throw new WorktreeCheckpointError('snapshot-failed', 'git write-tree returned no tree.')
    }
    return { tree, head, indexTree }
  })
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`
}

export async function writeWorktreeCheckpoint(
  repo: CheckpointRepo,
  ref: string,
  snapshot: WorktreeTree,
  meta: Omit<WorktreeCheckpointMeta, 'v' | 'head' | 'indexTree'>
): Promise<WorktreeCheckpoint> {
  if (!ref.startsWith(CHECKPOINT_REF_ROOT)) {
    throw new Error(`checkpoint refs live under ${CHECKPOINT_REF_ROOT}: ${ref}`)
  }
  const full: WorktreeCheckpointMeta = {
    v: 1,
    kind: meta.kind,
    head: snapshot.head,
    indexTree: snapshot.indexTree,
    createdAt: meta.createdAt,
    ...(meta.labels ? { labels: meta.labels } : {})
  }
  const headParent = snapshot.head ? ['-p', snapshot.head] : []
  // Commit dates follow the caller's clock, so retention and ordering read one timeline.
  const stamp = `@${Math.floor(meta.createdAt / 1000)} +0000`
  const env = { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
  // The staged tree rides as the second parent so gc keeps it as long as the checkpoint.
  const indexCommit = snapshot.indexTree
    ? (
        await repo.git(
          [
            'commit-tree',
            '--no-gpg-sign',
            snapshot.indexTree,
            ...headParent,
            '-m',
            'Orca checkpoint index'
          ],
          { env }
        )
      ).trim()
    : null
  const commit = (
    await repo.git(
      [
        'commit-tree',
        '--no-gpg-sign',
        snapshot.tree,
        ...headParent,
        ...(indexCommit ? ['-p', indexCommit] : []),
        '-m',
        `Orca checkpoint (${meta.kind})\n\n${META_PREFIX}${JSON.stringify(full)}`
      ],
      { env }
    )
  ).trim()
  await repo.git(['update-ref', ref, commit])
  return { ...full, ref, commit, tree: snapshot.tree }
}

export async function captureWorktreeCheckpoint(
  repo: CheckpointRepo,
  ref: string,
  meta: Omit<WorktreeCheckpointMeta, 'v' | 'head' | 'indexTree'>,
  options: CaptureOptions = {}
): Promise<WorktreeCheckpoint> {
  return writeWorktreeCheckpoint(repo, ref, await captureWorktreeTree(repo, options), meta)
}

export async function readWorktreeCheckpoint(
  repo: CheckpointRepo,
  ref: string
): Promise<WorktreeCheckpoint | null> {
  if (!ref.startsWith(CHECKPOINT_REF_ROOT)) {
    return null
  }
  const commit = await resolveCommit(repo, ref)
  if (!commit) {
    return null
  }
  const out = await repo.git(['show', '-s', '--format=%T%x00%B', commit])
  const [tree, body = ''] = out.split('\0')
  const line = body.split('\n').find((candidate) => candidate.startsWith(META_PREFIX))
  const meta = line ? parseMeta(line.slice(META_PREFIX.length)) : null
  return meta ? { ...meta, ref, commit, tree: tree.trim() } : null
}

const MetaSchema = z.object({
  v: z.literal(1),
  kind: z.enum(['turn', 'undo']),
  head: z.string().nullable(),
  indexTree: z.string().nullable(),
  createdAt: z.number(),
  labels: z.record(z.string(), z.string()).optional()
})

function parseMeta(text: string): WorktreeCheckpointMeta | null {
  try {
    const parsed = MetaSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
