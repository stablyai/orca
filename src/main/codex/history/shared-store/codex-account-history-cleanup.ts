import type { BigIntStats } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { MERGE_PENDING_SUFFIX } from '../../../filesystem/merged-directory-link'
import type { CodexHistoryCleanupKind } from '../cleanup-policy/codex-history-cleanup-policy'
import type { CodexHistoryCleanupSweepPolicy } from '../cleanup-policy/codex-history-cleanup-policy-live-update'
import { cleanUpUnusedDatabases, eligibleDatabaseGroups } from './codex-account-database-cleanup'
import {
  SET_ASIDE_ROLLOUTS_DIR,
  PRE_SHARE_DATABASES_DIR,
  fromManifestPath,
  readManifest,
  type CodexHistoryCleanupManifest,
  type FileFacts,
  sameFacts,
  storeFileFacts,
  updateManifest
} from './codex-account-history-cleanup-manifest'
import { contentSha256 } from './codex-account-history-content-check'
import {
  MAX_TRANSIENT_DELETE_FAILURES,
  hasProvenShared,
  isTransientDeleteError,
  openFilesOnce
} from './codex-account-history-delete-guards'
import { isCodexAccountHistoryLinked } from './codex-account-history-links'
import {
  currentLeftBehindFile,
  freedBy,
  isLeftBehindPath,
  removeEmptyFolders
} from './codex-account-left-behind-paths'
import {
  CleanupBudget,
  CleanupBudgetExceeded,
  emptyCleanupResult,
  type CodexHistoryCleanupResult
} from './codex-history-cleanup-sweep-tally'

type ReadyRollout = {
  path: string
  stats: BigIntStats
  facts: FileFacts
  sha256: string
  transientFailures: number
}

/**
 * Deletes what sharing left behind in an account home, exactly as the cleanup manifest proved it
 * redundant: a set-aside rollout form or merge conflict whose content matched the store copy, while
 * both files keep the size and mtime that check saw, the home file still hashes the same and the
 * home is still shared; and the home's own databases, untouched for the grace period, once the
 * home has worked shared that long. In report mode every check runs but nothing is deleted.
 */
export async function cleanUpCodexHistoryLeftBehind(args: {
  accountHome: string
  storeHome: string
  now: number
  shouldStop: () => boolean
  policy: CodexHistoryCleanupSweepPolicy
  /** The sweep's, already partly spent by its content check. */
  budget?: CleanupBudget
}): Promise<CodexHistoryCleanupResult> {
  const result = emptyCleanupResult()
  const budget = args.budget ?? new CleanupBudget()
  const home = args.accountHome
  const { policy } = args
  const manifest = await readManifest(home)
  if (!manifest || manifest === 'newer' || manifest.storeHome !== args.storeHome) {
    return result
  }
  const enforcing = (kind: CodexHistoryCleanupKind): boolean => policy[kind].mode === 'enforce'
  // A kill switch or a lapsed grant stops a kind at once; a widened one waits for the next sweep.
  const stopKind = (kind: CodexHistoryCleanupKind): boolean => {
    const live = policy.liveMode(kind)
    const changed = live === 'off' || (enforcing(kind) && live !== 'enforce')
    result.policyChanged ||= changed
    return args.shouldStop() || changed
  }
  const deleted = new Set<string>()
  // Proven copies that couldn't be deleted, or no longer hash the same: their check stops counting
  // as a match, so they aren't hashed or retried again until they change. Enforce only: report
  // mode never changes what a later enforce sweep may delete.
  const voided = new Map<string, FileFacts>()
  const busy = new Map<string, { facts: FileFacts; failures: number }>()
  const remove =
    (kind: CodexHistoryCleanupKind) =>
    async (path: string, stats: BigIntStats): Promise<void> => {
      await unlink(fromManifestPath(home, path))
      deleted.add(path)
      result[kind].deleted += 1
      result[kind].bytes += freedBy(stats)
    }

  const ready = policy.rollouts.mode === 'off' ? [] : await readyRollouts(manifest)
  const leftBehindDatabases =
    policy.databases.mode === 'off'
      ? []
      : manifest.databases.filter((database) => isLeftBehindPath(database.path, 'database'))
  result.databases.candidates = leftBehindDatabases.length
  const databaseRule = policy.databases.thresholds
  const provenShared = hasProvenShared(manifest, args.now, databaseRule)
  if (!provenShared) {
    result.databases.skipped.not_proven_shared += leftBehindDatabases.length
  }
  // Asked before taking the lock, which a starting pass waits only seconds for. A Codex still
  // holding one open would lose its later writes.
  const readyDatabases =
    provenShared && leftBehindDatabases.length > 0
      ? (
          await eligibleDatabaseGroups({
            home,
            databases: leftBehindDatabases,
            now: args.now,
            minUnchangedDays: databaseRule.minUnchangedDays,
            shouldStop: args.shouldStop,
            budget
          })
        ).flatMap((group) => group.files)
      : []
  if (provenShared) {
    result.databases.skipped.changed += leftBehindDatabases.length - readyDatabases.length
  }
  // One open-file check per run covers both kinds, and comes before any hash, so one that can't
  // tell costs no hashing.
  const targets = [...ready, ...readyDatabases].map((file) => fromManifestPath(home, file.path))
  const open =
    targets.length === 0 || args.shouldStop()
      ? null
      : await openFilesOnce(home, targets, args.shouldStop)
  if (!open && targets.length > 0) {
    result.rollouts.skipped.open_unknown += ready.length
    result.databases.skipped.open_unknown += readyDatabases.length
  }
  for (const rollout of open ? ready : []) {
    if (stopKind('rollouts')) {
      break
    }
    if (open!.has(fromManifestPath(home, rollout.path))) {
      result.rollouts.skipped.open += 1
      continue
    }
    if (!budget.fits(rollout.facts.bytes)) {
      continue
    }
    if (!(await settleRollout(rollout))) {
      break
    }
  }
  // The databases' proof is the sharing streak, so they go under the manifest's lock, which every
  // pass that changes the streak (or unshares and moves the databases aside) takes too.
  await updateManifest(home, async (current) => {
    if (!current || current.storeHome !== args.storeHome) {
      return null
    }
    if (open && readyDatabases.length > 0 && hasProvenShared(current, args.now, databaseRule)) {
      await cleanUpUnusedDatabases({
        home,
        storeHome: args.storeHome,
        databases: current.databases,
        now: args.now,
        minUnchangedDays: databaseRule.minUnchangedDays,
        open,
        checked: new Set(readyDatabases.map((database) => database.path)),
        mode: policy.databases.mode,
        tally: result.databases,
        shouldStop: args.shouldStop,
        mayUnlink: () => !stopKind('databases') && !budget.pastDeadline(),
        remove: remove('databases')
      })
    }
    if (deleted.size === 0 && voided.size === 0 && busy.size === 0) {
      return null
    }
    if (deleted.size > 0) {
      await removeLeftBehindFolders()
    }
    return {
      ...current,
      rollouts: current.rollouts
        .filter((rollout) => !deleted.has(rollout.path))
        .map((rollout) => {
          if (!rollout.check) {
            return rollout
          }
          const failed = busy.get(rollout.path)
          // Only the check this sweep acted on: a pass may have seen the file change since.
          if (sameFacts(rollout, voided.get(rollout.path) ?? null)) {
            return { ...rollout, check: { ...rollout.check, sameContent: false } }
          }
          return failed && sameFacts(rollout, failed.facts)
            ? { ...rollout, check: { ...rollout.check, transientFailures: failed.failures } }
            : rollout
        }),
      databases: current.databases.filter((database) => !deleted.has(database.path)),
      updatedAt: new Date(args.now).toISOString()
    }
  })
  result.budgetHit = budget.hit
  return result

  // Each proof is the file itself and its store copy, so no pass can void it meanwhile. A random
  // start keeps copies left open from holding back the rest run after run.
  async function readyRollouts(leftBehind: CodexHistoryCleanupManifest): Promise<ReadyRollout[]> {
    const proven = leftBehind.rollouts.filter(
      (rollout) =>
        rollout.check?.sameContent &&
        rollout.storePath === rollout.check.store.path &&
        isLeftBehindPath(rollout.path, 'rollout')
    )
    result.rollouts.candidates = proven.length
    // An account no longer shared keeps its own copies.
    if (
      proven.length > 0 &&
      (leftBehind.lastSharedAt === null ||
        leftBehind.sharedPasses < policy.rollouts.thresholds.minSharedPasses ||
        !(await isCodexAccountHistoryLinked(home, args.storeHome)))
    ) {
      result.rollouts.skipped.unshared += proven.length
      return []
    }
    const offset = Math.floor(Math.random() * proven.length)
    const found: ReadyRollout[] = []
    for (const rollout of [...proven.slice(offset), ...proven.slice(0, offset)]) {
      if (stopKind('rollouts') || !budget.startFiles()) {
        break
      }
      try {
        const check = rollout.check!
        const file = await currentLeftBehindFile(home, rollout.path)
        if (
          !file ||
          !sameFacts(rollout, file.facts) ||
          !sameFacts(check.store, await storeFileFacts(args.storeHome, check.store.path))
        ) {
          result.rollouts.skipped.changed += 1
        } else if (file.stats.nlink > 1n) {
          // Its other name, in a home not yet moved, keeps the space; probing it could disturb that
          // home's Codex.
          result.rollouts.skipped.hard_linked += 1
        } else {
          found.push({
            path: rollout.path,
            stats: file.stats,
            facts: file.facts,
            sha256: check.sha256,
            transientFailures: check.transientFailures ?? 0
          })
        }
      } catch {
        // Left for a later run: the manifest still lists it.
      }
    }
    return found
  }

  // False when the rest of the sweep's rollouts should wait for a later one.
  async function settleRollout(rollout: ReadyRollout): Promise<boolean> {
    const tally = result.rollouts
    try {
      // Size and a millisecond mtime can miss a same-size rewrite of the copy being deleted.
      if ((await contentSha256(fromManifestPath(home, rollout.path), budget)) !== rollout.sha256) {
        if (enforcing('rollouts')) {
          voided.set(rollout.path, rollout.facts)
        }
        tally.skipped.rehash_mismatch += 1
        return true
      }
      // Unchanged since the check: a writer that appended and closed meanwhile shows here.
      const now = await currentLeftBehindFile(home, rollout.path)
      if (!now || !sameFacts(rollout.facts, now.facts) || now.stats.nlink > 1n) {
        tally.skipped.changed += 1
        return true
      }
      // Unsharing unlinks the folders before it records anything, so the links themselves tell.
      if (!(await isCodexAccountHistoryLinked(home, args.storeHome))) {
        tally.skipped.unshared += 1
        return false
      }
      tally.eligible += 1
      if (!enforcing('rollouts')) {
        tally.deleted += 1
        tally.bytes += freedBy(rollout.stats)
        return true
      }
      if (stopKind('rollouts') || budget.pastDeadline()) {
        return false
      }
      await remove('rollouts')(rollout.path, rollout.stats).catch((error: unknown) => {
        const failures = rollout.transientFailures + 1
        if (isTransientDeleteError(error) && failures < MAX_TRANSIENT_DELETE_FAILURES) {
          busy.set(rollout.path, { facts: rollout.facts, failures })
          tally.skipped.unlink_failed += 1
        } else {
          voided.set(rollout.path, rollout.facts)
          tally.skipped[isTransientDeleteError(error) ? 'transient_capped' : 'unlink_failed'] += 1
        }
      })
    } catch (error) {
      // Left for a later run; a hash the budget cut short ends the sweep's rollouts.
      return !(error instanceof CleanupBudgetExceeded)
    }
    return true
  }

  async function removeLeftBehindFolders(): Promise<void> {
    try {
      for (const entry of await readdir(home, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          (entry.name === SET_ASIDE_ROLLOUTS_DIR ||
            entry.name === PRE_SHARE_DATABASES_DIR ||
            entry.name.endsWith(MERGE_PENDING_SUFFIX))
        ) {
          await removeEmptyFolders(join(home, entry.name), args.shouldStop)
        }
      }
    } catch {
      // Empty folders are left for a later run.
    }
  }
}
