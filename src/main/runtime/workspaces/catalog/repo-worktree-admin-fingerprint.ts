import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveGitCommonDirectory } from '../../../../shared/git/metadata/git-common-directory'
import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import type { Repo } from '../../../../shared/repository/repo-types'
import type {
  WorktreeAdminProbeResult,
  WorktreeCatalogVerifier
} from '../../../workspaces/catalog/repo-worktree-catalog-observation'
import {
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
} from './worktree-scan-admin-budget'

// NUL can appear in neither a path nor a Git ref, so field boundaries stay unambiguous.
const FIELD_SEPARATOR = '\u0000'
const MISSING = '-'
// Bound per-repo filesystem probes so hundreds of worktrees cannot flood the polling threadpool.
const LINKED_WORKTREE_PROBE_CONCURRENCY = 8

const inFlightAdminFingerprintProbes = new Map<string, Promise<WorktreeAdminProbeResult>>()
const lastFingerprintUnknownWarnAt = new Map<string, number>()

/** Local-admin verifier shared by desktop and runtime catalog readers of one repo. */
export function createLocalAdminFingerprintVerifier(
  repo: Pick<Repo, 'id' | 'path'>
): WorktreeCatalogVerifier {
  return {
    ceilingMs: WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS,
    probe: () => startSharedRepoWorktreeAdminFingerprintProbe(repo.id, repo.path),
    onUnknown: (reason) => warnWorktreeAdminFingerprintUnknownOnce(repo.id, reason)
  }
}

/** One outstanding probe per repo, joined by every reader: timeouts do not cancel readdir/stat, so
 * repeated probes could exhaust libuv on wedged mounts. Joiners share its budget instead of restarting it. */
function startSharedRepoWorktreeAdminFingerprintProbe(
  repoId: string,
  repoPath: string
): Promise<WorktreeAdminProbeResult> {
  const pending = inFlightAdminFingerprintProbes.get(repoId)
  if (pending) {
    return pending
  }
  const probe = readRepoWorktreeAdminFingerprint(repoPath)
    .then((fingerprint) => ({ fingerprint }))
    .finally(() => {
      inFlightAdminFingerprintProbes.delete(repoId)
    })
  const bounded = withTimeout<WorktreeAdminProbeResult>(
    probe,
    WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
    'timeout'
  )
  inFlightAdminFingerprintProbes.set(repoId, bounded)
  return bounded
}

// Why once per reconcile window: a wedged mount answers "unknown" on every poll.
function warnWorktreeAdminFingerprintUnknownOnce(repoId: string, reason: string): void {
  const now = Date.now()
  const last = lastFingerprintUnknownWarnAt.get(repoId)
  if (last !== undefined && now - last < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS) {
    return
  }
  lastFingerprintUnknownWarnAt.set(repoId, now)
  console.warn(
    '[worktree-scan] admin fingerprint unknown; reusing cached rows until the reconcile ceiling',
    {
      repoId,
      reason
    }
  )
}

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
      async (name) => await readLinkedWorktreeStamp(commonDir, adminDir, name, reftable !== MISSING)
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
  name: string,
  reftable: boolean
): Promise<string> {
  const entryDir = path.join(adminDir, name)
  // `gitdir` holds "<worktree>/.git"; its contents follow `git worktree move` and `git worktree repair`.
  const gitdirTarget = await readTrimmedFile(path.join(entryDir, 'gitdir'))
  const [head, locked, worktreeExists, worktreeRefs] = await Promise.all([
    readHeadStamp(commonDir, entryDir),
    readFileStamp(path.join(entryDir, 'locked')),
    // Deleting a worktree directory outside Orca flips its `prunable` row without touching the admin dir.
    gitdirTarget ? readExistenceStamp(path.dirname(gitdirTarget)) : Promise.resolve(MISSING),
    // Reftable keeps a linked HEAD in its own stack (HEAD file is a fixed stub); every update renames tables.
    reftable ? readTrimmedFile(path.join(entryDir, 'reftable', 'tables.list')) : null
  ])
  return [
    name,
    gitdirTarget ?? MISSING,
    head,
    locked,
    worktreeExists,
    worktreeRefs ?? MISSING
  ].join(FIELD_SEPARATOR)
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
  // Per-worktree refs (`refs/bisect`, `refs/worktree`, `refs/rewritten`) live beside a linked checkout;
  // shared refs (`refs/heads/*`, etc.) live in commonDir, so avoid a guaranteed ENOENT in headDir.
  const tip =
    headDir !== commonDir && isPerWorktreeRefName(refName)
      ? ((await readTrimmedFile(path.join(headDir, refName))) ??
        (await readTrimmedFile(path.join(commonDir, refName))))
      : await readTrimmedFile(path.join(commonDir, refName))
  return [head, tip ?? MISSING].join(FIELD_SEPARATOR)
}

function isPerWorktreeRefName(refName: string): boolean {
  const normalized = refName.replaceAll('\\', '/')
  return (
    normalized.startsWith('refs/bisect/') ||
    normalized.startsWith('refs/worktree/') ||
    normalized.startsWith('refs/rewritten/')
  )
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
