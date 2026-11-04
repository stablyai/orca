import type Database from '../sqlite/sync-database'
import { isDeepStrictEqual } from 'node:util'
import {
  retiredSurfacePtyIds,
  type WorkspaceSurface
} from '../../shared/workspace-surfaces/surface-content'
import type {
  SurfaceContentReplacement,
  SurfaceMoveRequest,
  SurfaceCommandOutcome
} from '../../shared/workspace-surfaces/surface-command'
import { compareSurfaceTarget } from './surface-layout-targets'
import { readSurface, withRetiredChatViews, writeChanges, advanceDomain } from './surface-rows'
import { readAllocation, writeAllocation } from './surface-allocation-rows'
import {
  runTargetOf,
  type SurfaceAllocation
} from '../../shared/workspace-surfaces/surface-allocation'
import { conflictingSurfaceIdentity } from './surface-identities'

/** Replacement, its resource decisions and legacy membership share the caller's transaction. */
export function replaceSurfaceContent(
  db: Database.Database,
  request: SurfaceContentReplacement,
  mintId: () => string,
  now: () => number
): SurfaceCommandOutcome {
  const conflict = compareSurfaceTarget(db, request, {
    hostTabId: request.hostTabId,
    expected: request.expected
  })
  if (conflict) {
    return conflict
  }
  const before = readSurface(db, request)
  const next: WorkspaceSurface = {
    hostId: request.hostId,
    workspaceId: request.workspaceId,
    hostTabId: request.hostTabId,
    occurrence: mintId(),
    revision: (before?.revision ?? 0) + 1,
    createdAt: before?.createdAt ?? now(),
    content: request.content
  }
  const adopted: SurfaceAllocation[] = []
  if (next.content?.kind === 'terminal') {
    for (const [leafId, leaf] of Object.entries(next.content.leaves)) {
      if (!leaf.facts.ptyId) {
        continue
      }
      const previous = before?.content?.kind === 'terminal' ? before.content.leaves[leafId] : null
      if (
        previous?.runId === leaf.runId &&
        previous.occurrence === leaf.occurrence &&
        previous.facts.ptyId === leaf.facts.ptyId &&
        previous.facts.incarnationId === leaf.facts.incarnationId
      ) {
        continue
      }
      const allocation = readAllocation(db, request.hostId, leaf.runId)
      const resource = {
        ptyId: leaf.facts.ptyId,
        ...(leaf.facts.incarnationId ? { incarnationId: leaf.facts.incarnationId } : {})
      }
      if (allocation?.decision !== 'pending' || !isDeepStrictEqual(allocation.resource, resource)) {
        return { status: 'conflict', code: 'terminal_allocation_required', current: before }
      }
      adopted.push({
        ...allocation,
        decision: 'committed' as const,
        target: runTargetOf(next, leafId)!
      })
    }
  }
  const changed = withRetiredChatViews(db, [next], mintId)
  const identityConflict = conflictingSurfaceIdentity(db, changed)
  if (identityConflict) {
    return identityConflict
  }
  writeChanges(db, changed)
  for (const allocation of adopted) {
    writeAllocation(db, allocation)
  }
  return {
    status: 'accepted',
    revision: advanceDomain(db, request.hostId),
    surfaces: changed,
    result: { tabId: next.hostTabId },
    effects: {
      stopPtyIds: retiredSurfacePtyIds(before?.content, next.content),
      startPaneKeys: []
    }
  }
}

/** Membership moves retain leaf/run identities and transfer any outstanding resource obligation. */
export function moveSurfaceContent(
  db: Database.Database,
  request: SurfaceMoveRequest,
  mintId: () => string
): SurfaceCommandOutcome {
  const sourceConflict = compareSurfaceTarget(db, request, {
    hostTabId: request.hostTabId,
    expected: request.expected
  })
  if (sourceConflict) {
    return sourceConflict
  }
  const destination = { hostId: request.hostId, ...request.destination }
  const targetConflict = compareSurfaceTarget(db, destination, request.destination)
  if (targetConflict) {
    return targetConflict
  }
  const source = readSurface(db, request)
  if (
    !source?.content ||
    (source.workspaceId === destination.workspaceId && source.hostTabId === destination.hostTabId)
  ) {
    return { status: 'conflict', code: 'surface_changed', current: source }
  }
  const target = readSurface(db, destination)
  if (target?.content) {
    return { status: 'conflict', code: 'tab_exists', current: target }
  }
  const changes: WorkspaceSurface[] = [
    { ...source, content: null, occurrence: mintId(), revision: source.revision + 1 },
    {
      ...source,
      workspaceId: destination.workspaceId,
      hostTabId: destination.hostTabId,
      occurrence: mintId(),
      revision: (target?.revision ?? 0) + 1
    }
  ]
  const identityConflict = conflictingSurfaceIdentity(db, changes)
  if (identityConflict) {
    return identityConflict
  }
  writeChanges(db, changes)
  return {
    status: 'accepted',
    revision: advanceDomain(db, request.hostId),
    surfaces: changes,
    result: { tabId: destination.hostTabId },
    effects: { startPaneKeys: [], stopPtyIds: [] }
  }
}
