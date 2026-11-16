import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { healPendingCodexAccountThreads } from '../index/codex-account-session-index-heal'
import type { CodexSessionIndexHealOptions } from '../index/codex-session-index-heal'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'
import { listCodexIndexPendingRollouts } from './codex-account-history-links'

let stopping = false
const hostHealsByPendingDir = new Map<string, Promise<void>>()
const rerunRequested = new Set<string>()
// Stores whose last heal stopped or failed with work left; a later launch retries them.
const incompleteHeals = new Set<string>()

export function hasIncompleteHostCodexIndexHeal(pendingDir: string): boolean {
  return incompleteHeals.has(normalizeRuntimePathForComparison(pendingDir))
}

/** Stops background index work at quit; settled rows and markers are kept. */
export function stopCodexAccountHistoryWork(): void {
  stopping = true
}

export function isCodexAccountHistoryWorkStopping(): boolean {
  return stopping
}

/**
 * Codex's own `thread/read` against the store indexes each moved rollout, newest first, so
 * the store's /resume list shows it; a marker dies once its read settles (a failure retries
 * on a later launch).
 */
export async function healCodexIndexPendingRollouts(args: {
  storeHome: string
  rolloutNames: readonly string[]
  clear: (rolloutNames: readonly string[]) => Promise<void>
  /** True once a history pass started after this heal did: its markers may name unmoved files. */
  passStartedSince?: () => boolean
  options?: CodexSessionIndexHealOptions
}): Promise<boolean> {
  const pending = new Map<string, string>()
  // A thread may own several rollouts (a .zst twin, a revert); one read settles them all.
  const markersByThreadId = new Map<string, string[]>()
  const withoutThread: string[] = []
  for (const name of args.rolloutNames) {
    const rollout = parseCodexRolloutThreadId(name)
    if (rollout) {
      if ((pending.get(rollout.threadId) ?? '') < rollout.rolloutStamp) {
        pending.set(rollout.threadId, rollout.rolloutStamp)
      }
      const markers = markersByThreadId.get(rollout.threadId) ?? []
      markers.push(name)
      markersByThreadId.set(rollout.threadId, markers)
    } else {
      withoutThread.push(name)
    }
  }
  if (withoutThread.length > 0) {
    // No thread id means no read can ever settle it.
    await args.clear(withoutThread)
  }
  if (pending.size === 0) {
    return true
  }
  if (stopping) {
    return false
  }
  const options = args.options ?? {}
  const summary = await healPendingCodexAccountThreads(args.storeHome, pending, {
    ...options,
    shouldStop: () => stopping || options.shouldStop?.() === true,
    afterBatch: async (settled) => {
      await options.afterBatch?.(settled)
      // A file a newer pass has yet to move reads as missing; its marker must stay.
      const keepMissing = args.passStartedSince?.() === true
      await args.clear(
        settled
          .filter(({ outcome }) => outcome === 'healed' || (outcome === 'missing' && !keepMissing))
          .flatMap(({ threadId }) => markersByThreadId.get(threadId) ?? [])
      )
    }
  })
  return summary.outcome === 'completed' || summary.outcome === 'up-to-date'
}

/**
 * One background pass per store, and only while no history pass runs (`isPaused`): a pass may
 * have recorded markers for files not moved yet, which a read would wrongly settle as missing.
 * A request while one runs reruns it afterwards, from whatever markers are left.
 */
export function requestHostCodexIndexHeal(
  pendingDir: string,
  storeHome: string,
  passes: { isPaused: () => boolean; started: () => number }
): void {
  const { isPaused } = passes
  const key = normalizeRuntimePathForComparison(pendingDir)
  if (stopping || isPaused()) {
    return
  }
  if (hostHealsByPendingDir.has(key)) {
    rerunRequested.add(key)
    return
  }
  const startedAtRequest = passes.started()
  const task = listCodexIndexPendingRollouts(pendingDir)
    .then((rolloutNames) =>
      healCodexIndexPendingRollouts({
        storeHome,
        rolloutNames,
        clear: async (names) => {
          for (const name of names) {
            await unlink(join(pendingDir, name)).catch((error: unknown) => {
              if (!isDefinitiveAbsence(error)) {
                throw error
              }
            })
          }
        },
        passStartedSince: () => passes.started() !== startedAtRequest,
        options: { shouldStop: isPaused }
      })
    )
    .then((finished) => {
      if (finished) {
        incompleteHeals.delete(key)
      } else {
        incompleteHeals.add(key)
      }
    })
    .catch((error: unknown) => {
      incompleteHeals.add(key)
      console.warn('[codex-account-history] Indexing shared history failed:', error)
    })
    .finally(() => {
      hostHealsByPendingDir.delete(key)
      if (rerunRequested.delete(key)) {
        requestHostCodexIndexHeal(pendingDir, storeHome, passes)
      }
    })
  hostHealsByPendingDir.set(key, task)
}

export const _internals = {
  reset: (): void => {
    stopping = false
    hostHealsByPendingDir.clear()
    rerunRequested.clear()
    incompleteHeals.clear()
  }
}
