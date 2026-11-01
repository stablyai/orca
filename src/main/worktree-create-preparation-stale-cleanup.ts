import {
  isWorktreeCreatePreparation,
  parseWorktreePreparationOwnerMachine,
  parseWorktreePreparationOwnerPid,
  parseWorktreePreparationPathOwnerPid
} from '../shared/worktree/create-preparation'
import { orcadDataRootIsOnLocalDisk } from './orcad/orcad-data-root-locality'
import { profileStateAccessMachineIdentity } from './persistence/profile-state/profile-state-access-identity'
import type { AddWorktreeOptions } from './git/worktree'
import { listWorktreeGraph } from './git/worktree'
import { discardPreparedWorktree, unlockPreparedWorktree } from './git/worktree-create-preparation'
import { retryPendingPreparationDiscards } from './worktree-preparation-discard-retry'

const STALE_PREPARATION_CLEANUP_CONCURRENCY = 4

const staleCleanupInFlight = new Map<string, { scanned: Promise<void>; settled: Promise<void> }>()

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export type PreparationOwnerProbe = {
  machineIdentity: () => string | null
  repoIsOnLocalDisk: (repoPath: string) => boolean
  isProcessAlive: (pid: number) => boolean
}

const defaultOwnerProbe: PreparationOwnerProbe = {
  machineIdentity: profileStateAccessMachineIdentity,
  repoIsOnLocalDisk: orcadDataRootIsOnLocalDisk,
  isProcessAlive
}

/** A PID proves owner exit only on its issuing machine; shared disks do not establish ownership. */
export function preparationOwnerExitedHere(
  lockReason: string,
  repoPath: string,
  options: Pick<AddWorktreeOptions, 'wslDistro'>,
  probe: PreparationOwnerProbe = defaultOwnerProbe
): boolean {
  const ownerPid = parseWorktreePreparationOwnerPid(lockReason)
  if (!ownerPid) {
    return false
  }
  const ownerMachine = parseWorktreePreparationOwnerMachine(lockReason)
  // Older reasons name no machine: their pid is evidence only where no other host sees the repo.
  const judgeable = ownerMachine
    ? ownerMachine === probe.machineIdentity()
    : Boolean(options.wslDistro) || probe.repoIsOnLocalDisk(repoPath)
  return judgeable && !probe.isProcessAlive(ownerPid)
}

/** Returns after the shared host scan; file reclamation stays tracked in the background. */
export async function startStalePreparationCleanup(
  cleanupKey: string,
  repoPath: string,
  options: AddWorktreeOptions
): Promise<void> {
  const existing = staleCleanupInFlight.get(cleanupKey)
  if (existing) {
    await existing.scanned.catch(() => {})
    return
  }
  void retryPendingPreparationDiscards(cleanupKey)
  // Reclaim in background to avoid blocking creates; retain caller priority for the scan they await.
  const reclaimOptions: AddWorktreeOptions = { ...options, admissionTier: 'background' }
  const scan = listWorktreeGraph(repoPath, {
    ...options,
    includeCreatePreparations: true
  })
  const scanned = scan.then(() => {})
  const cleanup = scan.then(async (worktrees) => {
    const staleWorktrees = worktrees.filter(isWorktreeCreatePreparation)
    let nextIndex = 0
    async function discardNextStalePreparation(): Promise<void> {
      while (nextIndex < staleWorktrees.length) {
        const worktree = staleWorktrees[nextIndex]
        nextIndex += 1
        const lockOwnerPid = parseWorktreePreparationOwnerPid(worktree.lockReason)
        const pathOwnerPid = parseWorktreePreparationPathOwnerPid(worktree.path)
        if (
          !worktree.lockReason ||
          !lockOwnerPid ||
          !preparationOwnerExitedHere(worktree.lockReason, repoPath, options)
        ) {
          continue
        }
        // Preserve branch-attached final paths after crashes; only hidden or detached preparations are disposable.
        if (worktree.branch && pathOwnerPid === null) {
          await unlockPreparedWorktree(
            repoPath,
            worktree.path,
            reclaimOptions,
            worktree.lockReason
          ).catch(() => {})
        } else if (pathOwnerPid === lockOwnerPid) {
          await discardPreparedWorktree(
            repoPath,
            worktree.path,
            reclaimOptions,
            worktree.lockReason
          ).catch(() => {})
        }
      }
    }
    const workerCount = Math.min(STALE_PREPARATION_CLEANUP_CONCURRENCY, staleWorktrees.length)
    await Promise.all(Array.from({ length: workerCount }, () => discardNextStalePreparation()))
  })
  // Keep reclamation single-flighted, but do not make a new checkout wait for old file removal.
  const entry = { scanned, settled: cleanup }
  staleCleanupInFlight.set(cleanupKey, entry)
  void cleanup
    .catch(() => {})
    .finally(() => {
      if (staleCleanupInFlight.get(cleanupKey) === entry) {
        staleCleanupInFlight.delete(cleanupKey)
      }
    })
  await scanned.catch(() => {})
}

/** Keeps repo maintenance paused through crash-recovery scanning and reclamation. */
export function hasPendingStalePreparationCleanup(): boolean {
  return staleCleanupInFlight.size > 0
}

export async function resetStalePreparationCleanupForTests(): Promise<void> {
  const cleanups = [...staleCleanupInFlight.values()].map((entry) => entry.settled)
  staleCleanupInFlight.clear()
  await Promise.allSettled(cleanups)
}
