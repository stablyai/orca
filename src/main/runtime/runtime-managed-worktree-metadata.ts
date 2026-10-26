import { getRepoRegistrationHostIds } from '../../shared/repo-host-identity'
import type { GitPushTarget, Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { WorktreeSortOrderUpdate } from '../../shared/worktree/sort-order-update'
import { stripOrcaProvenanceMetaUpdates } from '../worktree-removal-safety'
import { isRemovedFolderWorkspaceInstance } from '../folder-workspace-meta-presence'
import { worktreeRowTarget } from '../persistence/host-qualified-worktree-meta'
import {
  writeWorktreeSortOrder,
  type WorktreeSortOrderRequest
} from '../persistence/worktree-sort-order-write'
import type { RuntimeStore } from './runtime-store-contract'
import {
  isWslMoveSourceHost,
  isWslMoveWorkspaceBlocked,
  shouldDropWslMoveProjectUpdate,
  wslMoveProjectRefForWorkspace
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { RuntimeLineageError } from './runtime-worktree-lineage-resolution'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

type Updates = Omit<Partial<WorktreeMeta>, 'pushTarget'> & {
  pushTarget?: GitPushTarget | null
  lineage?: { parentWorktree?: string; noParent?: boolean }
}

type Ports = {
  resolveWorktree: (selector: string) => Promise<ResolvedWorktree>
  validateParent: (worktree: ResolvedWorktree, parent: ResolvedWorktree) => void
  invalidateResolved: () => void
  invalidateScan: (repoId: string) => void
  notifyChanged: (repoId: string) => void
  showWorktree: (selector: string) => Promise<Worktree>
}

export async function updateRuntimeManagedWorktreeMetadata(args: {
  selector: string
  updates: Updates
  store: RuntimeStore
  ports: Ports
}): Promise<Worktree> {
  const worktree = await args.ports.resolveWorktree(args.selector)
  const { lineage, ...metaUpdates } = args.updates
  const previousParentRepoId = lineage
    ? splitWorktreeId(args.store.getWorktreeLineage?.(worktree.id)?.parentWorktreeId ?? '')?.repoId
    : undefined
  let nextParentRepoId: string | undefined
  const executionHostId = worktree.identity?.executionHostId ?? worktree.hostId
  if (
    isWslMoveSourceHost(executionHostId) &&
    shouldDropWslMoveProjectUpdate(
      args.store,
      wslMoveProjectRefForWorkspace(worktree.id),
      lineage ? args.updates : metaUpdates
    )
  ) {
    return worktree
  }
  const target = worktreeRowTarget(args.store, { id: worktree.id, hostId: executionHostId })
  if (!target) {
    throw new Error('selector_ambiguous')
  }
  if (lineage?.parentWorktree) {
    args.ports.invalidateResolved()
    args.ports.invalidateScan(worktree.repoId)
  }
  const clearPushTarget =
    Object.hasOwn(metaUpdates, 'pushTarget') && metaUpdates.pushTarget === null
  const normalized: Partial<WorktreeMeta> = clearPushTarget
    ? { ...metaUpdates, pushTarget: undefined }
    : (metaUpdates as Partial<WorktreeMeta>)
  const persisted: Partial<WorktreeMeta> = omitUndefinedProperties(
    normalized.displayName !== undefined
      ? {
          ...normalized,
          pendingFirstAgentMessageRename: false,
          firstAgentMessageRenameError: null
        }
      : normalized
  )
  if (clearPushTarget) {
    persisted.pushTarget = undefined
  }
  if (lineage?.noParent === true) {
    args.store.removeWorktreeLineage?.(target)
  } else if (lineage?.parentWorktree) {
    const parent = await args.ports.resolveWorktree(lineage.parentWorktree)
    args.ports.validateParent(worktree, parent)
    nextParentRepoId = parent.repoId
    if (!worktree.instanceId || !parent.instanceId) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_MISSING',
        'Worktree instance identity was unavailable.'
      )
    }
    if (!args.store.setWorktreeLineage) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_MISSING',
        'Worktree lineage storage was unavailable.'
      )
    }
    const createdAt = Date.now()
    const recorded = args.store.setWorktreeLineage(target, {
      worktreeId: worktree.id,
      worktreeInstanceId: worktree.instanceId,
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: parent.instanceId,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt
    })
    if (!recorded) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'A same-id workspace on another host owns this lineage.'
      )
    }
    args.store.setWorkspaceLineage?.({
      childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
      childInstanceId: worktree.instanceId,
      parentWorkspaceKey: worktreeWorkspaceKey(parent.id),
      parentInstanceId: parent.instanceId,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt
    })
  }
  const metadataUpdates = stripOrcaProvenanceMetaUpdates(persisted)
  // Recheck removal: an earlier resolution snapshot may still contain this workspace (#22712).
  if (isRemovedFolderWorkspaceInstance(args.store, worktree.id, executionHostId)) {
    throw new Error('selector_not_found')
  }
  args.store.setWorktreeMeta(target, metadataUpdates)
  // Push explicitly for CLI mutations outside renderer optimistic updates.
  args.ports.invalidateResolved()
  args.ports.notifyChanged(worktree.repoId)
  if (lineage) {
    for (const repoId of new Set([previousParentRepoId, nextParentRepoId])) {
      if (repoId && repoId !== worktree.repoId) {
        args.ports.notifyChanged(repoId)
      }
    }
  }
  return args.ports.showWorktree(`id:${worktree.id}`)
}

export function persistRuntimeManagedWorktreeSortOrder(args: {
  orderedIds: WorktreeSortOrderRequest['orderedIds']
  hostIds?: WorktreeSortOrderRequest['hostIds']
  store: RuntimeStore
  invalidateResolved: () => void
  /** `sortOrders` omitted: the repo has same-id copies, which an id-keyed patch cannot tell apart. */
  notifyChanged: (repoId: string, sortOrders?: WorktreeSortOrderUpdate[]) => void
}): { updated: number } {
  // Skip moving projects but save/publish the rest; report only written orders.
  const updates = writeWorktreeSortOrder(
    args.store,
    { orderedIds: args.orderedIds, hostIds: args.hostIds },
    (worktreeId) => isWslMoveWorkspaceBlocked(args.store, worktreeId),
    Date.now()
  )
  if (updates.length === 0) {
    return { updated: 0 }
  }
  args.invalidateResolved()
  const updatesByRepo = new Map<string, WorktreeSortOrderUpdate[]>()
  for (const update of updates) {
    const repoId = splitWorktreeId(update.worktreeId)?.repoId
    if (repoId) {
      updatesByRepo.set(repoId, [...(updatesByRepo.get(repoId) ?? []), update])
    }
  }
  for (const [repoId, sortOrders] of updatesByRepo) {
    const isTwin = getRepoRegistrationHostIds(args.store.getRepos(), repoId).size > 1
    args.notifyChanged(repoId, isTwin ? undefined : sortOrders)
  }
  return { updated: updates.length }
}

function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}
