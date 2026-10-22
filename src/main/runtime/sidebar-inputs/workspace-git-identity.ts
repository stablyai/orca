import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  composeWorktreeHostIdentity,
  hostWorktreeTarget,
  type HostScopedWorktreeKey,
  type HostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import {
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  HOSTED_REVIEW_LINK_KEYS,
  canonicalHostedReviewBranchIdentity
} from '../../../shared/worktree/hosted-review-links'
import {
  getRepoHostIdentityForParts,
  type HostScopedRepoKey
} from '../../../shared/repo-host-identity'

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
  Partial<Pick<Worktree, (typeof HOSTED_REVIEW_LINK_KEYS)[number]>>

/** A row from a scan that reached a verdict, with the git run (scan-cache entry) it came from. */
export type ScannedIdentityRow = IdentityRow & { gitRun: object | null }

type Observed = {
  instanceId: string
  repoKey: HostScopedRepoKey
  branch: string
  displayName: string
  gitRun: object | null
  /** The links as they stood when git last confirmed `branch`. */
  links: string
}

export type HostedReviewLinkClear = {
  target: HostWorktreeTarget
  updates: Pick<WorktreeMeta, (typeof HOSTED_REVIEW_LINK_KEYS)[number] | 'pushTarget'>
}

function keyOf(row: Pick<IdentityRow, 'id' | 'hostId'>): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(row.hostId, row.id)
}

function linksSignature(row: IdentityRow): string {
  return JSON.stringify([...HOSTED_REVIEW_LINK_KEYS.map((key) => row[key] ?? null), row.pushTarget])
}

function hasBranchScopedLinks(row: IdentityRow): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => row[key] != null) || row.pushTarget !== undefined
}

/**
 * What a branch switch does to a workspace, decided where the scan sees it: an automatic title
 * follows the branch (and keeps its last name while the head is detached), and links scoped to the
 * old branch are cleared. Replaces the window's writer (worktree-git-identity-update.ts), which
 * P5b-2 deletes.
 */
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

  /**
   * Records an applied scan's rows. `rows` are those of scans that reached a verdict (a stalled
   * scan's stored rows read as detached); `scannedRepoKeys` are those repos, whose missing rows are
   * gone. Returns the link clears the branch switches call for.
   */
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
      const switched =
        sameInstance &&
        canonicalHostedReviewBranchIdentity(before.branch) !==
          canonicalHostedReviewBranchIdentity(row.branch)
      // A link written since git last confirmed the old branch may belong to the new one: kept.
      const cleared = switched && hasBranchScopedLinks(row) && linksSignature(row) === before.links
      if (cleared && row.hostId !== undefined) {
        clears.push({
          target: hostWorktreeTarget({ id: row.id, hostId: row.hostId }),
          updates: CLEARED_HOSTED_REVIEW_LINK_UPDATES
        })
      }
      if (row.instanceId === undefined) {
        this.observed.delete(key)
        continue
      }
      // A cached scan repeats an old branch; only a new git run (or a switch) confirms links on it.
      const confirmed =
        !sameInstance || switched || (row.gitRun !== null && row.gitRun !== before.gitRun)
      this.observed.set(key, {
        instanceId: row.instanceId,
        repoKey: getRepoHostIdentityForParts(row.repoId, row.hostId ?? ''),
        branch: row.branch,
        displayName: this.title(row),
        gitRun: row.gitRun,
        links: cleared
          ? linksSignature({ ...row, ...CLEARED_HOSTED_REVIEW_LINK_UPDATES })
          : confirmed
            ? linksSignature(row)
            : (before?.links ?? linksSignature(row))
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
