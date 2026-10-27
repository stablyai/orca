import {
  classifyWorktreeBaseChange,
  type WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import {
  EMPTY_HEAD_IDENTITY_SCOPE,
  mergeHeadIdentityScopes,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'

type WorktreeBaseWatcherEvent = {
  type: 'create' | 'update' | 'delete'
  path: string
}

export type WorktreeBaseCollectedChanges = {
  structureRepoIds: string[]
  gitStatusRepoIds: string[]
  headIdentityRepoIds: string[]
  headIdentityScope: WorktreeHeadIdentityScope
  gitStatusScope: WorktreeHeadIdentityScope
}

export function hasCollectedWorktreeBaseChanges(changes: WorktreeBaseCollectedChanges): boolean {
  return [changes.structureRepoIds, changes.gitStatusRepoIds, changes.headIdentityRepoIds].some(
    (ids) => ids.length > 0
  )
}

type ChangeBuckets = {
  structureRepoIds: Set<string>
  gitStatusRepoIds: Set<string>
  headIdentityRepoIds: Set<string>
  headIdentityScope: WorktreeHeadIdentityScope
  gitStatusScope: WorktreeHeadIdentityScope
}

function emptyBuckets(): ChangeBuckets {
  return {
    structureRepoIds: new Set<string>(),
    gitStatusRepoIds: new Set<string>(),
    headIdentityRepoIds: new Set<string>(),
    headIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE,
    gitStatusScope: EMPTY_HEAD_IDENTITY_SCOPE
  }
}

function addMatchingChange(
  target: WorktreeBaseWatchTarget,
  event: WorktreeBaseWatcherEvent,
  buckets: ChangeBuckets
): void {
  const change = classifyWorktreeBaseChange(target, event)
  for (const repoId of change.structureRepoIds) {
    buckets.structureRepoIds.add(repoId)
  }
  for (const repoId of change.gitStatusRepoIds) {
    buckets.gitStatusRepoIds.add(repoId)
  }
  for (const repoId of change.headIdentityRepoIds) {
    buckets.headIdentityRepoIds.add(repoId)
  }
  buckets.headIdentityScope = mergeHeadIdentityScopes(
    buckets.headIdentityScope,
    change.headIdentityScope
  )
  buckets.gitStatusScope = mergeHeadIdentityScopes(buckets.gitStatusScope, change.gitStatusScope)
}

function toCollectedChanges(buckets: ChangeBuckets): WorktreeBaseCollectedChanges {
  return {
    structureRepoIds: [...buckets.structureRepoIds],
    gitStatusRepoIds: [...buckets.gitStatusRepoIds],
    headIdentityRepoIds: [...buckets.headIdentityRepoIds],
    headIdentityScope: buckets.headIdentityScope,
    gitStatusScope: buckets.gitStatusScope
  }
}

export function collectLocalWorktreeBaseChanges(
  target: WorktreeBaseWatchTarget,
  events: WorktreeBaseWatcherEvent[]
): WorktreeBaseCollectedChanges {
  const buckets = emptyBuckets()
  for (const event of events) {
    addMatchingChange(target, event, buckets)
  }
  return toCollectedChanges(buckets)
}
