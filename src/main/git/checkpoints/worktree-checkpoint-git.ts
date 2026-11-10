// Git plumbing for worktree checkpoints. Every command here reads, or writes only objects, refs
// under refs/orca/checkpoints/ and private temp index files: the user's HEAD, branch, index and
// stash list are never touched by a snapshot.

import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { copyFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { gitExecFileAsync } from '../command-runner/git-exec-file'

export const CHECKPOINT_REF_ROOT = 'refs/orca/checkpoints/'

/** Identity for checkpoint commits, so repos without user.name/user.email still snapshot. */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Orca',
  GIT_AUTHOR_EMAIL: 'checkpoints@orca.invalid',
  GIT_COMMITTER_NAME: 'Orca',
  GIT_COMMITTER_EMAIL: 'checkpoints@orca.invalid'
}

export type CheckpointGitOptions = {
  env?: Record<string, string>
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type CheckpointGit = (args: string[], options?: CheckpointGitOptions) => Promise<string>

export type CheckpointRepo = {
  /** The worktree root; every path below is relative to it. */
  root: string
  /** The worktree's own git dir (a linked worktree has its own index and temp files there). */
  gitDir: string
  /** The user's index file. Copied, never written, by a snapshot. */
  indexFile: string
  git: CheckpointGit
}

export class WorktreeCheckpointError extends Error {
  constructor(
    readonly reason:
      | 'not-a-repo'
      | 'not-found'
      | 'merge-conflicts'
      | 'blocked-path'
      | 'unsafe-path'
      | 'snapshot-failed'
      /** Files changed before the restore failed; `undoRef` puts them back. */
      | 'partial',
    message: string,
    readonly paths: string[] = [],
    readonly undoRef?: string
  ) {
    super(message)
    this.name = 'WorktreeCheckpointError'
  }
}

export function gitExitCode(error: unknown): number | null {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  return typeof code === 'number' ? code : null
}

export function defaultCheckpointGit(cwd: string): CheckpointGit {
  return async (args, options = {}) => {
    const { stdout } = await gitExecFileAsync(args, {
      cwd,
      // Plumbing only: no optional locks, so a snapshot never contends with the user's own git.
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        ...CHECKPOINT_IDENTITY,
        ...options.env
      },
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 256 * 1024 * 1024
    })
    return stdout
  }
}

/** Resolves the worktree that contains `directory`; throws `not-a-repo` for plain folders and bare repos. */
export async function openCheckpointRepo(
  directory: string,
  gitFor: (cwd: string) => CheckpointGit = defaultCheckpointGit
): Promise<CheckpointRepo> {
  let out: string
  try {
    out = await gitFor(directory)([
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-dir',
      '--git-path',
      'index'
    ])
  } catch (error) {
    throw new WorktreeCheckpointError(
      'not-a-repo',
      `${directory} is not inside a git worktree: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const [root, gitDir, indexFile] = out.split('\n').map((line) => line.trim())
  if (!root || !gitDir || !indexFile) {
    throw new WorktreeCheckpointError('not-a-repo', `${directory} has no worktree root.`)
  }
  return { root, gitDir, indexFile, git: gitFor(root) }
}

export async function resolveCommit(repo: CheckpointRepo, rev: string): Promise<string | null> {
  try {
    const out = await repo.git(['rev-parse', '-q', '--verify', `${rev}^{commit}`])
    return out.trim() || null
  } catch {
    return null
  }
}

const TEMP_INDEX_PREFIX = 'orca-checkpoint-'
const STALE_TEMP_INDEX_MS = 60 * 60 * 1000
const swept = new Set<string>()

/** Removes temp indexes a crashed process left behind (once per git dir per process). */
async function sweepStaleTempIndexes(gitDir: string): Promise<void> {
  if (swept.has(gitDir)) {
    return
  }
  swept.add(gitDir)
  const names = await readdir(gitDir).catch(() => [])
  for (const name of names) {
    if (!name.startsWith(TEMP_INDEX_PREFIX)) {
      continue
    }
    const path = join(gitDir, name)
    const info = await stat(path).catch(() => null)
    // ctime, not mtime: a live temp index carries the user index's (possibly old) mtime.
    if (info && Date.now() - Math.max(info.ctimeMs, info.mtimeMs) > STALE_TEMP_INDEX_MS) {
      await rm(path, { force: true })
    }
  }
}

/** Runs `run` against a private copy of the user's index (stat data included, so `add -A` stays
 *  incremental on large repos). The copy is deleted afterwards; the user's index is only read. */
export async function withTempIndex<T>(
  repo: CheckpointRepo,
  seedFromUserIndex: boolean,
  run: (env: Record<string, string>) => Promise<T>
): Promise<T> {
  await sweepStaleTempIndexes(repo.gitDir)
  const file = `${repo.gitDir}/${TEMP_INDEX_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}.index`
  try {
    if (seedFromUserIndex) {
      await seedTempIndex(repo.indexFile, file)
    }
    return await run({ GIT_INDEX_FILE: file })
  } finally {
    await rm(file, { force: true })
    await rm(`${file}.lock`, { force: true })
  }
}

/** Copies the user's index keeping its mtime. Git treats an entry as "racily clean" (and rehashes
 *  the file) only when the entry is not older than the index file itself; a copy stamped "now"
 *  would make a same-size edit made in the index's last second look unchanged and drop it from
 *  the snapshot. The mtime is read before the copy, so a concurrent rewrite only makes the copy
 *  look older, which means more rehashing, never less. */
async function seedTempIndex(indexFile: string, file: string): Promise<void> {
  let source: Stats
  try {
    source = await stat(indexFile)
  } catch (error) {
    // An unborn repo has no index yet; the empty temp index is the right seed.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  await copyFile(indexFile, file)
  await utimes(file, source.atime, source.mtime)
}

export type TreeChange = {
  status: 'A' | 'D' | 'M' | 'T'
  path: string
}

/** File-level differences from `fromTree` to `toTree`, renames split into delete + add.
 *  Submodule pointers are left out: a checkpoint never moves a submodule. */
export async function diffTrees(
  repo: CheckpointRepo,
  fromTree: string,
  toTree: string
): Promise<TreeChange[]> {
  if (fromTree === toTree) {
    return []
  }
  const out = await repo.git(['diff-tree', '-r', '-z', '--no-renames', '--raw', fromTree, toTree])
  const fields = out.split('\0')
  const changes: TreeChange[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]
    const path = fields[index + 1]
    if (!header.startsWith(':') || path === undefined) {
      continue
    }
    const [oldMode, newMode, , , status] = header.slice(1).split(' ')
    if (oldMode === '160000' || newMode === '160000') {
      continue
    }
    const kind = status?.charAt(0)
    if (kind === 'A' || kind === 'D' || kind === 'M' || kind === 'T') {
      changes.push({ status: kind, path })
    }
  }
  return changes
}

/** Paths git would refuse anyway; checked again so a bad tree can never reach outside the root. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\0') || /^[A-Za-z]:/.test(path)) {
    return false
  }
  return path.split(/[\\/]/).every((part) => part !== '' && part !== '..' && part !== '.git')
}
