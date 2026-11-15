import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import { healPendingCodexAccountThreads } from '../index/codex-account-session-index-heal'
import type { CodexSessionIndexHealOptions } from '../index/codex-session-index-heal'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'
import {
  CODEX_INDEX_PENDING_DIR,
  listCodexIndexPendingRollouts
} from './codex-account-history-links'

let stopping = false
const hostHealsByAccountHome = new Map<string, Promise<void>>()

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
  options?: CodexSessionIndexHealOptions
}): Promise<void> {
  const pending = new Map<string, string>()
  const markerByThreadId = new Map<string, string>()
  const withoutThread: string[] = []
  for (const name of args.rolloutNames) {
    const rollout = parseCodexRolloutThreadId(name)
    if (rollout) {
      pending.set(rollout.threadId, rollout.rolloutStamp)
      markerByThreadId.set(rollout.threadId, name)
    } else {
      withoutThread.push(name)
    }
  }
  if (withoutThread.length > 0) {
    // No thread id means no read can ever settle it.
    await args.clear(withoutThread)
  }
  if (pending.size === 0 || stopping) {
    return
  }
  const options = args.options ?? {}
  await healPendingCodexAccountThreads(args.storeHome, pending, {
    ...options,
    shouldStop: () => stopping || options.shouldStop?.() === true,
    afterBatch: async (settled) => {
      await options.afterBatch?.(settled)
      await args.clear(
        settled
          .filter(({ outcome }) => outcome !== 'failed')
          .flatMap(({ threadId }) => markerByThreadId.get(threadId) ?? [])
      )
    }
  })
}

/** One background pass per host account home; a later launch resumes what is left. */
export function startHostCodexAccountIndexHeal(accountHome: string, storeHome: string): void {
  const key = normalizeRuntimePathForComparison(accountHome)
  if (stopping || hostHealsByAccountHome.has(key)) {
    return
  }
  const pendingDir = join(accountHome, CODEX_INDEX_PENDING_DIR)
  const task = listCodexIndexPendingRollouts(accountHome)
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
        }
      })
    )
    .catch((error: unknown) => {
      console.warn('[codex-account-history] Indexing shared history failed:', error)
    })
    .finally(() => hostHealsByAccountHome.delete(key))
  hostHealsByAccountHome.set(key, task)
}

export const _internals = {
  reset: (): void => {
    stopping = false
    hostHealsByAccountHome.clear()
  }
}
