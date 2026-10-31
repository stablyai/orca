import type { AddWorktreeOptions } from './git/worktree'
import { discardPreparedWorktree } from './git/worktree-create-preparation'
import { WorktreePreparationLockOwnershipError } from './git/worktree-preparation-lock'
import { isOrphanedWorktreeError } from './ipc/worktree-logic'
import { trackPreparationWork } from './worktree-create-concurrency'
import type { PreparationEntry } from './worktree-create-preparation-pool'

// Retry live-owner discard failures on later preparations; stale cleanup only reclaims dead owners.
const PREPARATION_DISCARD_ATTEMPT_LIMIT = 3

export type PreparationDiscardTarget = {
  hostKey: string
  repoPath: string
  preparedPath: string
  lockReason: string
  options: AddWorktreeOptions
}

const pendingDiscards = new Map<string, PreparationDiscardTarget & { attempts: number }>()
const inFlightDiscards = new Set<Promise<unknown>>()

export function preparationHostKey(repoPathKey: string, wslDistro: string): string {
  return `${repoPathKey}\0${wslDistro}`
}

export async function discardPreparationEntry(entry: PreparationEntry): Promise<void> {
  await entry.ready.catch(() => {})
  if (!entry.checkoutStarted) {
    return
  }
  // Claim cleanup before yielding so queued refresh failures cannot discard the same checkout.
  entry.checkoutStarted = false
  await discardPreparationWithRetry({
    hostKey: preparationHostKey(entry.repoPathKey, entry.wslDistro),
    repoPath: entry.repoPath,
    preparedPath: entry.preparedPath,
    lockReason: entry.lockReason,
    options: entry.options
  })
}

/** Let test reset await detached discards before clearing the registry. */
export function trackPreparationDiscard(work: Promise<void>): void {
  inFlightDiscards.add(work)
  void work.finally(() => inFlightDiscards.delete(work))
}

function pendingKey(target: PreparationDiscardTarget): string {
  return `${target.hostKey}\0${target.preparedPath}`
}

async function runDiscard(target: PreparationDiscardTarget, attempts: number): Promise<void> {
  try {
    await discardPreparedWorktree(
      target.repoPath,
      target.preparedPath,
      target.options,
      target.lockReason
    )
  } catch (error) {
    // Checkout failure may already have removed the registration; do not retry missing or foreign entries.
    if (error instanceof WorktreePreparationLockOwnershipError || isOrphanedWorktreeError(error)) {
      return
    }
    // Bounded: a path that never becomes removable must not tax every later preparation.
    if (attempts >= PREPARATION_DISCARD_ATTEMPT_LIMIT) {
      console.warn(
        `[worktree-create] prepared checkout could not be discarded in ${attempts} attempts; ${target.preparedPath} stays registered until this process exits`,
        error
      )
      return
    }
    pendingDiscards.set(pendingKey(target), { ...target, attempts })
  }
}

/** Record failed discards for bounded retries. */
export function discardPreparationWithRetry(
  target: PreparationDiscardTarget,
  attempts = 1
): Promise<void> {
  // Claim the record so an overlapping retry pass cannot run the same discard twice.
  pendingDiscards.delete(pendingKey(target))
  const discard = trackPreparationWork(runDiscard(target, attempts))
  trackPreparationDiscard(discard)
  return discard
}

export function retryPendingPreparationDiscards(hostKey: string): Promise<void> {
  const pending = [...pendingDiscards.values()].filter((target) => target.hostKey === hostKey)
  return Promise.all(
    pending.map(({ attempts, ...target }) => discardPreparationWithRetry(target, attempts + 1))
  ).then(() => undefined)
}

/** Settle background discards before clearing their registry. */
export async function resetPendingPreparationDiscardsForTests(): Promise<void> {
  while (inFlightDiscards.size > 0) {
    await Promise.all(inFlightDiscards)
  }
  pendingDiscards.clear()
}
