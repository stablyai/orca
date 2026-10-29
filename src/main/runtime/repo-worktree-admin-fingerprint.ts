import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveGitCommonDirectory } from '../../shared/git-common-directory'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

// NUL can appear in neither a path nor a Git ref, so field boundaries stay unambiguous.
const FIELD_SEPARATOR = '\u0000'
const MISSING = '-'
// Bound per-repo filesystem probes so hundreds of worktrees cannot flood the polling threadpool.
const LINKED_WORKTREE_PROBE_CONCURRENCY = 8

/** Fingerprint local Git admin state without a subprocess; null requires a real scan.
 * Sparse patterns and opaque packed/reftable tips need periodic unconditional rescans beyond coarse file stamps. */
export async function readRepoWorktreeAdminFingerprint(repoPath: string): Promise<string | null> {
  try {
    const commonDir = await resolveGitCommonDirectory(repoPath)
    if (!commonDir) {
      return null
    }
    const adminDir = path.join(commonDir, 'worktrees')
    const names = await readLinkedWorktreeNames(adminDir)
    const [mainHead, mainExists, packedRefs, reftable] = await Promise.all([
      readHeadStamp(commonDir, commonDir),
      readExistenceStamp(repoPath),
      // A tip whose loose ref file was packed away still moves these.
      readFileStamp(path.join(commonDir, 'packed-refs')),
      readFileStamp(path.join(commonDir, 'reftable'))
    ])
    const linked = await mapWithConcurrency(
      names,
      LINKED_WORKTREE_PROBE_CONCURRENCY,
      async (name) => await readLinkedWorktreeStamp(commonDir, adminDir, name)
    )
    return [mainHead, mainExists, packedRefs, reftable, String(names.length), ...linked].join(
      FIELD_SEPARATOR
    )
  } catch {
    return null
  }
}

async function readLinkedWorktreeStamp(
  commonDir: string,
  adminDir: string,
  name: string
): Promise<string> {
  const entryDir = path.join(adminDir, name)
  // `gitdir` holds "<worktree>/.git"; its contents follow `git worktree move` and `git worktree repair`.
  const gitdirTarget = await readTrimmedFile(path.join(entryDir, 'gitdir'))
  const [head, locked, worktreeExists] = await Promise.all([
    readHeadStamp(commonDir, entryDir),
    readFileStamp(path.join(entryDir, 'locked')),
    // Deleting a worktree directory outside Orca flips its `prunable` row without touching the admin dir.
    gitdirTarget ? readExistenceStamp(path.dirname(gitdirTarget)) : Promise.resolve(MISSING)
  ])
  return [name, gitdirTarget ?? MISSING, head, locked, worktreeExists].join(FIELD_SEPARATOR)
}

/** Include symbolic HEAD's referenced tip; commits can move that ref without changing HEAD itself. */
async function readHeadStamp(commonDir: string, headDir: string): Promise<string> {
  const head = await readTrimmedFile(path.join(headDir, 'HEAD'))
  if (!head) {
    return MISSING
  }
  const refName = head.match(/^ref:\s*(.+?)\s*$/)?.[1]
  if (!refName || !isSafeRefName(refName)) {
    // Detached HEAD already holds the object id, and an unrecognized HEAD is covered by its own text.
    return head
  }
  // Per-worktree refs (`refs/bisect`, `refs/worktree`) live beside the checkout; branches are shared.
  const tip =
    (await readTrimmedFile(path.join(headDir, refName))) ??
    (await readTrimmedFile(path.join(commonDir, refName)))
  return [head, tip ?? MISSING].join(FIELD_SEPARATOR)
}

/** Keep a hand-edited HEAD from steering the probe outside the repo's ref store. */
function isSafeRefName(refName: string): boolean {
  const segments = refName.split(/[\\/]/)
  return (
    segments[0] === 'refs' &&
    segments.length > 1 &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') &&
    !path.isAbsolute(refName)
  )
}

async function readLinkedWorktreeNames(adminDir: string): Promise<string[]> {
  try {
    const entries = await readdir(adminDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (err) {
    // A repo with no linked worktrees has no admin dir at all; anything else is a real read failure.
    if (isMissingEntryError(err)) {
      return []
    }
    throw err
  }
}

async function readTrimmedFile(filePath: string): Promise<string | null> {
  try {
    const trimmed = (await readFile(filePath, 'utf-8')).trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (err) {
    if (isMissingEntryError(err)) {
      return null
    }
    throw err
  }
}

async function readFileStamp(filePath: string): Promise<string> {
  try {
    const stats = await stat(filePath)
    return `${stats.mtimeMs}:${stats.size}`
  } catch (err) {
    if (isMissingEntryError(err)) {
      return MISSING
    }
    throw err
  }
}

async function readExistenceStamp(targetPath: string): Promise<string> {
  try {
    await stat(targetPath)
    return 'y'
  } catch (err) {
    if (isMissingEntryError(err)) {
      return 'n'
    }
    throw err
  }
}

function isMissingEntryError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
