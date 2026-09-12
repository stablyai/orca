import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import {
  classifyWorktreeBaseChange,
  type WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import {
  EMPTY_HEAD_IDENTITY_SCOPE,
  FULL_HEAD_IDENTITY_SCOPE,
  mergeHeadIdentityScopes,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'

type WorktreeBaseWatcherEvent = {
  type: 'create' | 'update' | 'delete'
  path: string
}

export type WorktreeBaseCollectedChanges = {
  overflow: boolean
  structureRepoIds: string[]
  gitStatusRepoIds: string[]
  headIdentityRepoIds: string[]
  headIdentityScope: WorktreeHeadIdentityScope
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
}

function emptyBuckets(): ChangeBuckets {
  return {
    structureRepoIds: new Set<string>(),
    gitStatusRepoIds: new Set<string>(),
    headIdentityRepoIds: new Set<string>(),
    headIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE
  }
}

// Why: overflow means every event in the window was lost, so the scope must be
// stated as FULL here rather than left to a downstream `?? FULL` on an absent
// field — a caller that forwards this object must not read it as "nothing moved".
function overflowChanges(): WorktreeBaseCollectedChanges {
  return {
    overflow: true,
    structureRepoIds: [],
    gitStatusRepoIds: [],
    headIdentityRepoIds: [],
    headIdentityScope: FULL_HEAD_IDENTITY_SCOPE
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
}

function toCollectedChanges(buckets: ChangeBuckets): WorktreeBaseCollectedChanges {
  return {
    overflow: false,
    structureRepoIds: [...buckets.structureRepoIds],
    gitStatusRepoIds: [...buckets.gitStatusRepoIds],
    headIdentityRepoIds: [...buckets.headIdentityRepoIds],
    headIdentityScope: buckets.headIdentityScope
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

export function collectRemoteWorktreeBaseChanges(
  target: WorktreeBaseWatchTarget,
  events: FsChangeEvent[]
): WorktreeBaseCollectedChanges {
  const buckets = emptyBuckets()
  for (const event of events) {
    if (event.kind === 'overflow') {
      return overflowChanges()
    }
    if (event.kind === 'rename') {
      if (event.oldAbsolutePath) {
        addMatchingChange(target, { type: 'delete', path: event.oldAbsolutePath }, buckets)
      }
      addMatchingChange(target, { type: 'create', path: event.absolutePath }, buckets)
      continue
    }
    addMatchingChange(target, { type: event.kind, path: event.absolutePath }, buckets)
  }
  return toCollectedChanges(buckets)
}
