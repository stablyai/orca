import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'
import { COMPRESSED_ROLLOUT_SUFFIX } from '../rollouts/codex-rollout-compressed-twin'
import { CleanupBudgetExceeded, type CleanupBudget } from './codex-history-cleanup-sweep-tally'
import {
  factsOf,
  inventoryCodexHistoryLeftBehind,
  fromManifestPath,
  readManifest,
  sameFacts,
  storeFileFacts,
  updateManifest,
  type ContentCheck,
  type FileFacts,
  type LeftBehindRollout
} from './codex-account-history-cleanup-manifest'

/** Throws `CleanupBudgetExceeded` once `budget` runs out while reading. */
export async function contentSha256(path: string, budget?: CleanupBudget): Promise<string> {
  const hash = createHash('sha256')
  const raw = createReadStream(path, { highWaterMark: 1024 * 1024 })
  const charged = async function* (content: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const chunk of content) {
      budget?.read(chunk.length)
      yield chunk
    }
  }
  const digest = async (content: AsyncIterable<Buffer>): Promise<void> => {
    for await (const chunk of content) {
      // Decompressing can outlast the input: the deadline holds while consuming its output too.
      budget?.throwIfPastDeadline()
      hash.update(chunk)
    }
  }
  await (path.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
    ? pipeline(raw, charged, createZstdDecompress(), digest)
    : pipeline(raw, charged, digest))
  return hash.digest('hex')
}

async function checkContent(
  accountHome: string,
  storeHome: string,
  rollout: LeftBehindRollout,
  store: FileFacts,
  budget: CleanupBudget | undefined
): Promise<ContentCheck | null> {
  let sha256: string
  let storeSha256: string
  try {
    // Both settle before the sweep moves on, so a failed pair's other read can't overlap the next.
    const [ownCopy, storeCopy] = await Promise.allSettled([
      contentSha256(fromManifestPath(accountHome, rollout.path), budget),
      contentSha256(fromManifestPath(storeHome, store.path), budget)
    ])
    const failed = [ownCopy, storeCopy].flatMap((hashed) =>
      hashed.status === 'rejected' ? [hashed.reason] : []
    )
    if (ownCopy.status === 'rejected' || storeCopy.status === 'rejected') {
      throw failed.find((reason) => reason instanceof CleanupBudgetExceeded) ?? failed[0]
    }
    ;[sha256, storeSha256] = [ownCopy.value, storeCopy.value]
  } catch (error) {
    if (error instanceof CleanupBudgetExceeded) {
      throw error
    }
    // A corrupt `.zst` never matches; anything else (a moved file) is checked on a later pass.
    const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
    if (!code.startsWith('ZSTD_')) {
      return null
    }
    return { at: new Date().toISOString(), sameContent: false, sha256: '', store }
  }
  const home = await lstatIfPresent(fromManifestPath(accountHome, rollout.path))
  const homeFacts = home?.isFile()
    ? factsOf(accountHome, fromManifestPath(accountHome, rollout.path), home)
    : null
  if (
    !sameFacts(rollout, homeFacts) ||
    !sameFacts(store, await storeFileFacts(storeHome, store.path))
  ) {
    return null
  }
  return { at: new Date().toISOString(), sameContent: sha256 === storeSha256, sha256, store }
}

// Checkpoints rewrite the whole manifest, so they are spaced by time, not by count.
const SAVE_INTERVAL_MS = 30_000

/** A check report mode keeps in memory, for the rollout as it was when checked. */
export type UnsavedContentCheck = { facts: FileFacts; check: ContentCheck }

/** Report mode's view of a home for one sweep, never written: its inventory and its checks. */
export type ReportModeMemory = {
  rollouts: LeftBehindRollout[] | null
  checks: Map<string, UnsavedContentCheck>
}

/** The rollouts as report mode sees them: its own inventory, with its own checks where they hold. */
export function reportModeRollouts(
  saved: LeftBehindRollout[],
  memory: ReportModeMemory | undefined
): LeftBehindRollout[] {
  return (memory?.rollouts ?? saved).map((rollout) => {
    const unsaved = memory?.checks.get(rollout.path)
    return !rollout.check &&
      unsaved &&
      sameFacts(rollout, unsaved.facts) &&
      rollout.storePath === unsaved.check.store.path
      ? { ...rollout, check: unsaved.check }
      : rollout
  })
}

/**
 * Rebuilds the home's left-behind inventory, then compares each unchecked rollout with its store
 * copy, saving progress as it goes. False when `shouldStop` cut it short; a `budget` that runs out
 * ends it too, with the rest left for a later run. With `report`, nothing is written: the
 * inventory and the checks stay in that memory instead.
 */
export async function checkCodexHistoryLeftBehind(args: {
  accountHome: string
  storeHome: string
  shouldStop: () => boolean
  budget?: CleanupBudget
  report?: ReportModeMemory
}): Promise<boolean> {
  if (!(await readManifest(args.accountHome))) {
    return true
  }
  const walked = await inventoryCodexHistoryLeftBehind({
    ...args,
    shouldStop: () => args.shouldStop() || (args.budget?.pastDeadline() ?? false),
    persist: !args.report
  })
  if (!walked) {
    return !args.shouldStop()
  }
  const manifest = await readManifest(args.accountHome)
  if (!manifest || manifest === 'newer') {
    return true
  }
  if (args.report) {
    args.report.rollouts = walked
    const current = new Set(walked.map((rollout) => rollout.path))
    for (const path of args.report.checks.keys()) {
      if (!current.has(path)) {
        args.report.checks.delete(path)
      }
    }
  }
  const checks = new Map<string, { rollout: LeftBehindRollout; check: ContentCheck }>()
  const save = async (): Promise<void> => {
    const pending = new Map(checks)
    checks.clear()
    await updateManifest(args.accountHome, async (current) => {
      const base = current ?? manifest
      return {
        ...base,
        rollouts: base.rollouts.map((rollout) => {
          const checked = pending.get(rollout.path)
          // A pass meanwhile may have seen either file change; such a check is stale.
          return checked &&
            !rollout.check &&
            sameFacts(rollout, checked.rollout) &&
            rollout.storePath === checked.check.store.path
            ? { ...rollout, check: checked.check }
            : rollout
        })
      }
    })
  }
  let finished = true
  let savedAt = Date.now()
  // A random start keeps any one stretch of copies from taking every run's budget.
  const unchecked = reportModeRollouts(manifest.rollouts, args.report).filter(
    (rollout) => !rollout.check
  )
  const offset = Math.floor(Math.random() * unchecked.length)
  for (const rollout of [...unchecked.slice(offset), ...unchecked.slice(0, offset)]) {
    if (args.shouldStop()) {
      finished = false
      break
    }
    if (args.budget?.pastDeadline()) {
      break
    }
    // Only a copy that can be checked takes any budget.
    const store = rollout.storePath ? await storeFileFacts(args.storeHome, rollout.storePath) : null
    const bytes = rollout.bytes + (store?.bytes ?? 0)
    if (!store || args.budget?.skipOversized(rollout.path, bytes)) {
      continue
    }
    if (args.budget && (!args.budget.startFiles() || !args.budget.fits(bytes))) {
      break
    }
    let check: ContentCheck | null
    try {
      check = await checkContent(args.accountHome, args.storeHome, rollout, store, args.budget)
    } catch (error) {
      if (error instanceof CleanupBudgetExceeded) {
        break
      }
      throw error
    }
    if (check && args.report) {
      args.report.checks.set(rollout.path, { facts: rollout, check })
    } else if (check) {
      checks.set(rollout.path, { rollout, check })
    }
    if (checks.size > 0 && Date.now() - savedAt >= SAVE_INTERVAL_MS) {
      await save()
      savedAt = Date.now()
    }
  }
  if (checks.size > 0) {
    await save()
  }
  return finished
}
