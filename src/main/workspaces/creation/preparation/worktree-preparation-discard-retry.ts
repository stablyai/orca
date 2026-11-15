import { worktreePreparationGit } from '../../../git/worktrees/creation/worktree-create-git-executor'
import { trackPreparationWork } from '../worktree-create-concurrency'
import { blockedWslDistroForPath } from '../../../wsl/filesystem/wsl-unc-access-gate'
import type { PreparationEntry } from './worktree-create-preparation-pool'

const obligations = new Map<string, PreparationEntry>()
const inFlightDiscards = new Set<Promise<unknown>>()

export function preparationHostKey(repoPathKey: string, wslDistro: string): string {
  return `${repoPathKey}\0${wslDistro}`
}

function obligationKey(entry: PreparationEntry): string {
  return `${preparationHostKey(entry.repoPathKey, entry.wslDistro)}\0${entry.preparedPath}`
}

export function preparationCapacityUsed(): number {
  return obligations.size
}

export function registerPreparationObligation(entry: PreparationEntry): void {
  const key = obligationKey(entry)
  obligations.set(key, entry)
  entry.operation.setDisposalOwner({
    current: () => obligations.get(key) === entry,
    before: async () => !(await blockedWslDistroForPath(entry.repoPath, entry.options.wslDistro)),
    schedule: (run) => {
      const work = trackPreparationWork(worktreePreparationGit.run(run))
      trackPreparationDiscard(work)
      return work
    },
    disposed: () => {
      if (obligations.get(key) === entry) {
        obligations.delete(key)
      }
    }
  })
}

export function releasePreparationObligation(entry: PreparationEntry): void {
  const key = obligationKey(entry)
  if (obligations.get(key) !== entry) {
    return
  }
  obligations.delete(key)
  entry.operation.release()
}

export async function discardPreparationEntry(entry: PreparationEntry): Promise<void> {
  if (!entry.checkoutStarted) {
    return
  }
  // Claim submission before yielding; the capacity owner survives this claim.
  entry.checkoutStarted = false
  if (obligations.get(obligationKey(entry)) === entry) {
    await entry.operation.discard()
  }
}

export function trackPreparationDiscard(work: Promise<void>): void {
  inFlightDiscards.add(work)
  void work.then(
    () => inFlightDiscards.delete(work),
    () => inFlightDiscards.delete(work)
  )
}

export function retryPendingPreparationDiscards(hostKey?: string): Promise<void> {
  return Promise.all(
    [...obligations.values()]
      .filter(
        (entry) =>
          entry.operation.needsDiscardRetry &&
          (!hostKey || preparationHostKey(entry.repoPathKey, entry.wslDistro) === hostKey)
      )
      .map((entry) => entry.operation.discard())
  ).then(() => undefined)
}

export async function resetPendingPreparationDiscardsForTests(): Promise<void> {
  while (inFlightDiscards.size > 0) {
    await Promise.allSettled(inFlightDiscards)
  }
  for (const entry of obligations.values()) {
    entry.operation.release()
  }
  obligations.clear()
}
