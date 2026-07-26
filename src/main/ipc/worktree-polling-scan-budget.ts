export const WORKTREE_POLLING_MAX_SCANNED_ENTRIES = 100_000
export const WORKTREE_POLLING_MAX_RETAINED_PATHS = 16_384
export const WORKTREE_POLLING_MAX_RETAINED_PATH_BYTES = 16 * 1024 * 1024
export const WORKTREE_POLLING_MAX_REPO_CONFIGS = 4_096
export const WORKTREE_POLLING_MAX_RETAINED_REPO_BYTES = 4 * 1024 * 1024

export type WorktreePollingScanLimits = {
  maxScannedEntries: number
  maxRetainedPaths: number
  maxRetainedPathBytes: number
  maxRepoConfigs: number
  maxRetainedRepoBytes: number
}

export class WorktreePollingCapacityError extends Error {
  constructor(
    readonly resource:
      | 'scanned entries'
      | 'retained paths'
      | 'retained path bytes'
      | 'repo configs'
      | 'retained repo bytes',
    readonly observed: number,
    readonly limit: number
  ) {
    super(`Worktree polling exceeded ${limit} ${resource} (observed ${observed})`)
    this.name = 'WorktreePollingCapacityError'
  }
}

function resolveLimit(requested: number | undefined, maximum: number, name: string): number {
  if (requested === undefined) {
    return maximum
  }
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return Math.min(requested, maximum)
}

export class WorktreePollingScanBudget {
  private scannedEntries = 0
  private retainedPaths = 0
  private retainedPathBytes = 0
  private repoConfigs = 0
  private retainedRepoBytes = 0
  private readonly limits: WorktreePollingScanLimits

  constructor(requested: Partial<WorktreePollingScanLimits> = {}) {
    this.limits = {
      maxScannedEntries: resolveLimit(
        requested.maxScannedEntries,
        WORKTREE_POLLING_MAX_SCANNED_ENTRIES,
        'maxScannedEntries'
      ),
      maxRetainedPaths: resolveLimit(
        requested.maxRetainedPaths,
        WORKTREE_POLLING_MAX_RETAINED_PATHS,
        'maxRetainedPaths'
      ),
      maxRetainedPathBytes: resolveLimit(
        requested.maxRetainedPathBytes,
        WORKTREE_POLLING_MAX_RETAINED_PATH_BYTES,
        'maxRetainedPathBytes'
      ),
      maxRepoConfigs: resolveLimit(
        requested.maxRepoConfigs,
        WORKTREE_POLLING_MAX_REPO_CONFIGS,
        'maxRepoConfigs'
      ),
      maxRetainedRepoBytes: resolveLimit(
        requested.maxRetainedRepoBytes,
        WORKTREE_POLLING_MAX_RETAINED_REPO_BYTES,
        'maxRetainedRepoBytes'
      )
    }
  }

  claimEntry(): void {
    this.scannedEntries += 1
    if (this.scannedEntries > this.limits.maxScannedEntries) {
      throw new WorktreePollingCapacityError(
        'scanned entries',
        this.scannedEntries,
        this.limits.maxScannedEntries
      )
    }
  }

  claimRetainedPath(path: string): void {
    this.retainedPaths += 1
    if (this.retainedPaths > this.limits.maxRetainedPaths) {
      throw new WorktreePollingCapacityError(
        'retained paths',
        this.retainedPaths,
        this.limits.maxRetainedPaths
      )
    }
    this.retainedPathBytes += Buffer.byteLength(path, 'utf8')
    if (this.retainedPathBytes > this.limits.maxRetainedPathBytes) {
      throw new WorktreePollingCapacityError(
        'retained path bytes',
        this.retainedPathBytes,
        this.limits.maxRetainedPathBytes
      )
    }
  }

  claimRepoConfig(repoId: string, repoName: string): void {
    this.repoConfigs += 1
    if (this.repoConfigs > this.limits.maxRepoConfigs) {
      throw new WorktreePollingCapacityError(
        'repo configs',
        this.repoConfigs,
        this.limits.maxRepoConfigs
      )
    }
    this.retainedRepoBytes +=
      Buffer.byteLength(repoId, 'utf8') + Buffer.byteLength(repoName, 'utf8') + 128
    if (this.retainedRepoBytes > this.limits.maxRetainedRepoBytes) {
      throw new WorktreePollingCapacityError(
        'retained repo bytes',
        this.retainedRepoBytes,
        this.limits.maxRetainedRepoBytes
      )
    }
  }
}
