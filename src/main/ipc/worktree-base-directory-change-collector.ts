import type { FsChangeEvent } from '../../shared/types'
import {
  classifyWorktreeBaseChange,
  type WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

type WorktreeBaseWatcherEvent = {
  type: 'create' | 'update' | 'delete'
  path: string
}

export type WorktreeBaseCollectedChanges = {
  overflow: boolean
  structureRepoIds: string[]
  gitStatusRepoIds: string[]
}

function emptyChanges(): WorktreeBaseCollectedChanges {
  return { overflow: false, structureRepoIds: [], gitStatusRepoIds: [] }
}

function addMatchingChange(
  target: WorktreeBaseWatchTarget,
  event: WorktreeBaseWatcherEvent,
  structureRepoIds: Set<string>,
  gitStatusRepoIds: Set<string>
): void {
  const change = classifyWorktreeBaseChange(target, event)
  for (const repoId of change.structureRepoIds) {
    structureRepoIds.add(repoId)
  }
  for (const repoId of change.gitStatusRepoIds) {
    gitStatusRepoIds.add(repoId)
  }
}

function toCollectedChanges(
  structureRepoIds: Set<string>,
  gitStatusRepoIds: Set<string>
): WorktreeBaseCollectedChanges {
  return {
    overflow: false,
    structureRepoIds: [...structureRepoIds],
    gitStatusRepoIds: [...gitStatusRepoIds]
  }
}

export function collectLocalWorktreeBaseChanges(
  target: WorktreeBaseWatchTarget,
  events: WorktreeBaseWatcherEvent[]
): WorktreeBaseCollectedChanges {
  const structureRepoIds = new Set<string>()
  const gitStatusRepoIds = new Set<string>()
  for (const event of events) {
    addMatchingChange(target, event, structureRepoIds, gitStatusRepoIds)
  }
  return toCollectedChanges(structureRepoIds, gitStatusRepoIds)
}

export function collectRemoteWorktreeBaseChanges(
  target: WorktreeBaseWatchTarget,
  events: FsChangeEvent[]
): WorktreeBaseCollectedChanges {
  const structureRepoIds = new Set<string>()
  const gitStatusRepoIds = new Set<string>()
  for (const event of events) {
    if (event.kind === 'overflow') {
      return { ...emptyChanges(), overflow: true }
    }
    if (event.kind === 'rename') {
      if (event.oldAbsolutePath) {
        addMatchingChange(
          target,
          { type: 'delete', path: event.oldAbsolutePath },
          structureRepoIds,
          gitStatusRepoIds
        )
      }
      addMatchingChange(
        target,
        { type: 'create', path: event.absolutePath },
        structureRepoIds,
        gitStatusRepoIds
      )
      continue
    }
    addMatchingChange(
      target,
      { type: event.kind, path: event.absolutePath },
      structureRepoIds,
      gitStatusRepoIds
    )
  }
  return toCollectedChanges(structureRepoIds, gitStatusRepoIds)
}
