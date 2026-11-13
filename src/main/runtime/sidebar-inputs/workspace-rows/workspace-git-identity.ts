import type { Worktree } from '../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  hostWorktreeTarget,
  type HostScopedWorktreeKey,
  type HostWorktreeTarget
} from '../../../../shared/worktree/host-qualified-identity'
import type { HOSTED_REVIEW_LINK_KEYS } from '../../../../shared/worktree/hosted-review-links'
import {
  branchHostedReviewOwner,
  hostedReviewClearUpdates,
  type HostedReviewClearUpdates,
  type HostedReviewOwner
} from '../../../../shared/worktree/hosted-review-branch-ownership'
import {
  getRepoHostIdentityForParts,
  type HostScopedRepoKey
} from '../../../../shared/repo-host-identity'

type IdentityRow = Pick<
  Worktree,
  | 'id'
  | 'repoId'
  | 'hostId'
  | 'instanceId'
  | 'branch'
  | 'displayName'
  | 'displayNameMode'
  | 'pushTarget'
> &
  Partial<Pick<Worktree, 'linkedWorkItem'>> &
  Partial<Pick<Worktree, (typeof HOSTED_REVIEW_LINK_KEYS)[number]>>

/** A row from a scan that reached a verdict, with the git run (scan-cache entry) it came from. */
export type ScannedIdentityRow = IdentityRow & { gitRun: object | null }

type Observed = {
  instanceId: string
  repoKey: HostScopedRepoKey
  branch: string
  displayName: string
  gitRun: object | null
  /** The branch owning the review context, with its links as they stood when git last confirmed it. */
  owner: HostedReviewOwner | undefined
}

export type HostedReviewLinkClear = {
  target: HostWorktreeTarget
  updates: HostedReviewClearUpdates
}

function keyOf(row: Pick<IdentityRow, 'id' | 'hostId'>): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(row.hostId, row.id)
}

/** On proven branch switches, clear old-branch links and update automatic names; detached heads retain the last name and review ownership. Replaces worktree-git-identity-update.ts. */
export class WorkspaceGitIdentity {
  private readonly observed = new Map<HostScopedWorktreeKey, Observed>()
  private readonly detachedTitles = new Map<HostScopedWorktreeKey, string>()

  /** The title to publish for a row joined from the cached scan. */
  title(row: IdentityRow): string {
    const carried = this.detachedTitles.get(keyOf(row))
    return carried !== undefined && row.branch === '' && row.displayNameMode === 'automatic'
      ? carried
      : row.displayName
  }

  /** Record verdict-bearing scan rows/repo keys and return branch-switch link clears; stalled scans cannot confirm absence or branch identity. */
  observeScan(
    rows: readonly ScannedIdentityRow[],
    scannedRepoKeys: ReadonlySet<HostScopedRepoKey>
  ): HostedReviewLinkClear[] {
    const clears: HostedReviewLinkClear[] = []
    const seen = new Set<HostScopedWorktreeKey>()
    for (const row of rows) {
      const key = keyOf(row)
      seen.add(key)
      const before = this.observed.get(key)
      // With no instance id there is no proof two sightings are one workspace.
      const sameInstance =
        before !== undefined && row.instanceId !== undefined && before.instanceId === row.instanceId
      if (!sameInstance || row.branch !== '') {
        this.detachedTitles.delete(key)
      } else if (before.branch !== '' && row.displayNameMode === 'automatic') {
        this.detachedTitles.set(key, before.displayName)
      }
      const previousOwner = sameInstance ? before.owner : undefined
      const updates = hostedReviewClearUpdates(previousOwner, row.branch, row)
      if (updates && row.hostId !== undefined) {
        clears.push({ target: hostWorktreeTarget({ id: row.id, hostId: row.hostId }), updates })
      }
      if (row.instanceId === undefined) {
        this.observed.delete(key)
        continue
      }
      const afterClear = updates ? { ...row, ...updates } : row
      let owner: HostedReviewOwner | undefined
      if (row.branch === '') {
        owner = previousOwner
      } else {
        const branchOwner = branchHostedReviewOwner(row.branch, afterClear)
        // A cached scan repeats an old branch; only a new git run (or a change) confirms links on it.
        const repeatsCachedScan =
          sameInstance &&
          updates === null &&
          previousOwner !== undefined &&
          previousOwner.branch === branchOwner.branch &&
          (row.gitRun === null || row.gitRun === before.gitRun)
        owner = repeatsCachedScan ? previousOwner : branchOwner
      }
      this.observed.set(key, {
        instanceId: row.instanceId,
        repoKey: getRepoHostIdentityForParts(row.repoId, row.hostId ?? ''),
        branch: row.branch,
        displayName: this.title(row),
        gitRun: row.gitRun,
        owner
      })
    }
    for (const [key, observed] of this.observed) {
      if (!seen.has(key) && scannedRepoKeys.has(observed.repoKey)) {
        this.observed.delete(key)
        this.detachedTitles.delete(key)
      }
    }
    return clears
  }
}
