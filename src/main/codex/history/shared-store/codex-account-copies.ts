import type { BigIntStats } from 'node:fs'
import { basename, dirname, relative } from 'node:path'
import { COMPRESSED_ROLLOUT_SUFFIX } from '../rollouts/codex-rollout-compressed-twin'
import { findOriginal, sharedSince, walkCopies } from './codex-account-copy-roots'
import { originalHoldsCopy } from './codex-account-copy-content'
import {
  readCursor,
  readKeptCopies,
  takeInTurn,
  writeCursor,
  writeKeptCopies,
  type CompareProgress,
  type KeptCopies
} from './codex-account-copies-kept'
import { emptyTally, type CopiesTally } from './codex-account-copies-tally'
import {
  fileKey,
  isInsideHome,
  lstatOrNull,
  onlyOwnerWrites,
  type VerifiedCopy
} from './codex-account-copy-checks'
import { assertOwnedHostCodexManagedHomePath } from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'

// Sync file calls on purpose: this runs on its own worker thread (see the worker entry).

export const ACL_KEEP = 'acl:'
export const homeName = (accountHome: string, path: string): string =>
  relative(accountHome, path).split(/[\\/]/).join('/')
// What one launch's move phase can get through; the rest is verified again next launch.
const MAX_VERIFIED_PER_HOME = 5_000
// What the first oversized pair may read and take each launch, even past the launch's budget.
const OVERSIZED_SLICE_BYTES = 256 * 1024 ** 2
const OVERSIZED_SLICE_MS = 20_000

/** `maxBytes`: what this home may still read of copies and originals together. */
export type VerifyBudget = { maxBytes: number; deadline: number }

type Candidate = {
  name: string
  key: string
  copy: string
  copyStats: BigIntStats
  original: { path: string; stats: BigIntStats }
  /** Bytes an earlier launch matched with both files as they are now. */
  from: number
}

// Throws unless this is Orca's own account home (its marker names its account).
export function assertOwnedHome(args: {
  accountHome: string
  storeHome: string
  managedAccountsRoot: string
}): void {
  assertOwnedHostCodexManagedHomePath({
    candidatePath: args.accountHome,
    managedAccountsRoot: args.managedAccountsRoot,
    systemCodexHomePath: args.storeHome,
    expectedAccountId: basename(dirname(args.accountHome))
  })
}

/**
 * Compares each rollout copy the home kept with its ~/.codex original, within `budget` (copies past
 * it wait for a later launch). Moves nothing: the copies it returns still need the open check.
 */
export async function verifyCodexAccountCopies(args: {
  accountHome: string
  storeHome: string
  budget: VerifyBudget
  /** This Orca's version: a home this version settled, in the same share streak, isn't walked. */
  version: string
  managedAccountsRoot: string
}): Promise<{ verified: VerifiedCopy[]; tally: CopiesTally; bytesRead: number }> {
  const tally = emptyTally()
  const verified: VerifiedCopy[] = []
  assertOwnedHome(args)
  const since = sharedSince(args.accountHome)
  const stamp = since === null ? null : `${args.version}|${since}`
  const record = readKeptCopies(args.accountHome)
  if (stamp !== null && record.settled === stamp) {
    return { verified, tally, bytesRead: 0 }
  }
  const kept = record.differs
  const progress = record.progress ?? {}
  const remembered = record.verified ?? {}
  const nextKept: KeptCopies = {}
  const nextVerified: KeptCopies = {}
  // Passed last launch with both files unchanged, but not moved: offered after fresh copies, unread.
  const retry: VerifiedCopy[] = []
  const nextProgress: CompareProgress = {}
  const visited = new Set<string>()
  // Pairs larger than what's left of the budget: compared after every other copy, from saved progress.
  const oversized: Candidate[] = []
  let bytesRead = 0
  let outOfTime = false
  const compare = (candidate: Candidate, maxBytes: number, deadline: number): void => {
    const { name, key, copy, copyStats, original } = candidate
    const result = originalHoldsCopy(copy, original.path, copyStats.size, {
      from: candidate.from,
      maxBytes,
      deadline
    })
    const copyAfter = lstatOrNull(copy)
    const originalAfter = lstatOrNull(original.path)
    if (
      !copyAfter ||
      !originalAfter ||
      fileKey(copyAfter) !== fileKey(copyStats) ||
      fileKey(originalAfter) !== fileKey(original.stats)
    ) {
      tally.changed += 1
    } else if ('partial' in result) {
      // Resumes here next launch while both files keep these keys.
      nextProgress[name] = { key, matched: result.matched }
      tally.deferred += 1
    } else if (result.holds) {
      nextVerified[name] = key
      verified.push({
        copy,
        original: original.path,
        copyKey: fileKey(copyStats),
        originalKey: fileKey(original.stats)
      })
    } else {
      nextKept[name] = key
      tally.differs += 1
    }
  }
  const cursor = readCursor(args.accountHome)
  // Each launch starts after the copy the last one stopped at, so a walk the deadline cuts short
  // still reaches every copy over a few launches; folders before it are skipped unread.
  let lastVisited: string | undefined
  for (const { root, copy, segments } of walkCopies(
    args.accountHome,
    args.storeHome,
    cursor.walkAfter,
    args.budget.deadline
  )) {
    const name = segments.join('/')
    if (Date.now() > args.budget.deadline || verified.length >= MAX_VERIFIED_PER_HOME) {
      // The rest waits for a later launch, unvisited: its cost stays within the deadline.
      outOfTime = true
      tally.deferred += 1
      break
    }
    visited.add(name)
    lastVisited = name
    try {
      const copyStats = lstatOrNull(copy)
      if (!copyStats?.isFile()) {
        continue
      }
      if (!isInsideHome(args.accountHome, copy)) {
        tally.error += 1
        continue
      }
      const original = findOriginal(root, copy)
      if (original === 'error') {
        tally.error += 1
        continue
      }
      if (!original) {
        tally.missing_original += 1
        continue
      }
      // Another name for the copy's bytes could be a live writer's.
      if (copyStats.nlink > 1n || original.stats.ino === copyStats.ino) {
        tally.linked += 1
        continue
      }
      // Another user could write it, and no open check sees their processes: kept unread.
      if (!onlyOwnerWrites(copyStats)) {
        tally.open += 1
        continue
      }
      const key = `${fileKey(copyStats)}|${original.path}|${fileKey(original.stats)}`
      const sameForm =
        copy.endsWith(COMPRESSED_ROLLOUT_SUFFIX) ===
        original.path.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
      // One form compressed and the other not: kept. Decoding can't prove a `.zst` complete
      // (a cut-off frame or checksum still decodes), so content is only compared as stored.
      if (!sameForm) {
        tally.compressed += 1
        continue
      }
      // Kept last launch for an ACL: not read or offered again until either file changes, so
      // lasting keeps never fill a launch's candidates ahead of the copies behind them.
      if (kept[name] === `${ACL_KEEP}${key}`) {
        nextKept[name] = kept[name]
        tally.open += 1
        continue
      }
      if (kept[name] === key || copyStats.size > original.stats.size) {
        nextKept[name] = key
        tally.differs += 1
        continue
      }
      if (remembered[name] === key) {
        // The move rechecks both keys under the lock, and the trash compares again in full.
        nextVerified[name] = key
        retry.push({
          copy,
          original: original.path,
          copyKey: fileKey(copyStats),
          originalKey: fileKey(original.stats)
        })
        continue
      }
      const from = progress[name]?.key === key ? progress[name].matched : 0
      const candidate = { name, key, copy, copyStats, original, from }
      // The most the comparison reads of both files.
      const size = (Number(copyStats.size) - from) * 2 + 1
      if (bytesRead + size > args.budget.maxBytes) {
        oversized.push(candidate)
        continue
      }
      bytesRead += size
      compare(candidate, Infinity, args.budget.deadline)
    } catch {
      tally.error += 1
    }
  }
  // A walk the deadline or cap cut short stopped at a directory, not a copy: still unfinished.
  outOfTime ||= Date.now() > args.budget.deadline
  for (const [index, candidate] of oversized.entries()) {
    // Whatever the rest left; progress is saved, so each launch gets further.
    let allowance = Math.floor((args.budget.maxBytes - bytesRead - 1) / 2)
    let deadline = args.budget.deadline
    if (outOfTime || allowance <= 0 || Date.now() > deadline) {
      if (index > 0) {
        tally.deferred += 1
        if (progress[candidate.name]?.key === candidate.key) {
          nextProgress[candidate.name] = progress[candidate.name]
        }
        continue
      }
      // The first still gets a slice of its own, so oversized pairs progress every launch.
      allowance = OVERSIZED_SLICE_BYTES
      deadline = Date.now() + OVERSIZED_SLICE_MS
    }
    bytesRead += allowance * 2 + 1
    try {
      compare(candidate, allowance, deadline)
    } catch {
      tally.error += 1
    }
  }
  const turn = takeInTurn(
    retry,
    (copy) => homeName(args.accountHome, copy.copy),
    cursor.retryAfter,
    MAX_VERIFIED_PER_HOME - verified.length
  )
  verified.push(...turn.taken)
  tally.deferred += retry.length - turn.taken.length
  if (outOfTime) {
    for (const [name, key] of Object.entries(remembered)) {
      if (!visited.has(name)) {
        nextVerified[name] = key
      }
    }
    for (const [name, key] of Object.entries(kept)) {
      if (!visited.has(name)) {
        nextKept[name] = key
      }
    }
    for (const [name, saved] of Object.entries(progress)) {
      if (!visited.has(name)) {
        nextProgress[name] = saved
      }
    }
  }
  // Only what can't become deletable in this streak: a differing, open or orphaned copy could.
  const settled =
    stamp !== null &&
    verified.length === 0 &&
    tally.deferred +
      tally.changed +
      tally.error +
      tally.missing_original +
      tally.differs +
      tally.open +
      tally.busy ===
      0
  writeKeptCopies(
    args.accountHome,
    {
      differs: nextKept,
      settled: settled ? stamp : null,
      progress: nextProgress,
      verified: nextVerified
    },
    record
  )
  writeCursor(args.accountHome, {
    ...cursor,
    walkAfter: outOfTime ? (lastVisited ?? cursor.walkAfter) : undefined,
    retryAfter: turn.next
  })
  return { verified, tally, bytesRead }
}
