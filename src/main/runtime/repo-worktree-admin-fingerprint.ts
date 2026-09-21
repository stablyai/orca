import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

// NUL can appear in neither a path nor a Git ref, so field boundaries stay unambiguous.
const FIELD_SEPARATOR = '\u0000'
const MISSING = '-'
// Why: this runs per repo on a polling path, so a repo with hundreds of worktrees must not queue its
// whole admin dir onto the fs threadpool at once. Mirrors SPARSE_CHECKOUT_DETECTION_CONCURRENCY.
const LINKED_WORKTREE_PROBE_CONCURRENCY = 8

/**
 * Cheap, subprocess-free summary of a local repo's Git worktree administrative state.
 *
 * Equal fingerprints mean `git worktree list --porcelain` would report the same rows, so a caller
 * can extend a scan cache instead of spawning Git. `null` means "cannot prove unchanged" (not a
 * Git repo, unreadable layout, permission error) and callers must fall back to a real scan.
 *
 * Not covered: sparse-checkout pattern edits, and a tip moved through a ref store this cannot read
 * exactly (packed refs, the reftable backend), which fall back to a coarser mtime + size stamp.
 * Callers bound both with a periodic unconditional rescan.
 */
export async function readRepoWorktreeAdminFingerprint(repoPath: string): Promise<string | null> {
  try {
    const commonDir = await resolveGitCommonDir(repoPath)
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
    readExistenceStamp(path.join(entryDir, 'locked')),
    // Deleting a worktree directory outside Orca flips its `prunable` row without touching the admin dir.
    gitdirTarget ? readExistenceStamp(path.dirname(gitdirTarget)) : Promise.resolve(MISSING)
  ])
  return [name, gitdirTarget ?? MISSING, head, locked, worktreeExists].join(FIELD_SEPARATOR)
}

/**
 * Identify the commit `git worktree list` would print for one checkout: the HEAD line itself plus,
 * when HEAD is a symref, the tip it names. Reading the tip is what makes a plain commit visible —
 * committing rewrites `refs/heads/<branch>` and leaves HEAD untouched.
 */
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

async function resolveGitCommonDir(repoPath: string): Promise<string | null> {
  const gitDir = await resolveGitDir(repoPath)
  if (!gitDir) {
    return null
  }
  // A linked worktree's gitdir points at the shared admin root through `commondir`.
  const commonDir = await readTrimmedFile(path.join(gitDir, 'commondir'))
  return commonDir ? path.resolve(gitDir, commonDir) : gitDir
}

async function resolveGitDir(repoPath: string): Promise<string | null> {
  const dotGitPath = path.join(repoPath, '.git')
  let dotGitStats: Awaited<ReturnType<typeof stat>> | null = null
  try {
    dotGitStats = await stat(dotGitPath)
  } catch (err) {
    if (!isMissingEntryError(err)) {
      throw err
    }
  }
  if (!dotGitStats) {
    // Bare repo, or a repo path that already is a gitdir.
    return (await readExistenceStamp(path.join(repoPath, 'HEAD'))) === 'y' ? repoPath : null
  }
  if (dotGitStats.isDirectory()) {
    return dotGitPath
  }
  if (!dotGitStats.isFile()) {
    return null
  }
  const contents = await readTrimmedFile(dotGitPath)
  const match = contents?.match(/^gitdir:\s*(.+?)\s*$/m)
  return match ? path.resolve(repoPath, match[1]) : null
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
