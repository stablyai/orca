// Dependency-free so repo removal in persistence can drop a pending re-scan without loading the WSL gate.
const pendingByRepoId = new Map<string, () => void>()

/** One pending re-scan per repo: a newer hold cancels the older one. */
export function holdWslStoppedWorktreeRescan(repoId: string, cancel: () => void): void {
  const previous = pendingByRepoId.get(repoId)
  pendingByRepoId.set(repoId, cancel)
  previous?.()
}

/** `cancel` releases only that hold, so a stale callback cannot drop a newer one. */
export function releaseWslStoppedWorktreeRescan(repoId: string, cancel?: () => void): void {
  const current = pendingByRepoId.get(repoId)
  if (!current || (cancel && current !== cancel)) {
    return
  }
  pendingByRepoId.delete(repoId)
  current()
}

export function _pendingWslStoppedWorktreeRescanCount(): number {
  return pendingByRepoId.size
}

export function _resetWslStoppedWorktreeRescansForTests(): void {
  for (const cancel of pendingByRepoId.values()) {
    cancel()
  }
  pendingByRepoId.clear()
}
