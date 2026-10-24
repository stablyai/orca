import { readWorktreeLineageCorpus } from '../worktree-lineage-candidates'
import {
  isSameSavedWorktreeParent,
  sharesWorktreeLineageBoundary
} from '../../shared/resolved-worktree-lineage'
import type { ParentWorktreeRef } from '../../shared/worktree/lineage-types'
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
  lineage?: { parentWorktree?: string; parentWorktreeRef?: ParentWorktreeRef; noParent?: boolean }
}

type Ports = {
  resolveWorktree: (selector: string, instanceId?: string) => Promise<ResolvedWorktree>
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
  const childKey = worktree.id.startsWith('folder:')
    ? (`folder:${worktree.id.slice(7)}` as const)
    : worktreeWorkspaceKey(worktree.id)
  let facts = lineage ? readWorktreeLineageCorpus(args.store) : undefined
  if (facts && !facts.hasCurrent(worktree)) {
    throw new RuntimeLineageError(
      'LINEAGE_PARENT_INSTANCE_STALE',
      'The workspace changed. Refresh and try again.'
    )
  }
  let existingLineage = lineage ? facts?.edgeOf(worktree) : undefined
  let previousParentRepoId = lineage
    ? splitWorktreeId(existingLineage?.parentWorktreeId ?? '')?.repoId
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
  let target = worktreeRowTarget(args.store, { id: worktree.id, hostId: executionHostId })
  if (!target) {
    throw new Error('selector_ambiguous')
  }
  if (lineage?.parentWorktree || lineage?.parentWorktreeRef) {
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
  } else if (lineage?.parentWorktree || lineage?.parentWorktreeRef) {
    const ref = lineage.parentWorktreeRef
    const existing = existingLineage
    const identical = ref && isSameSavedWorktreeParent(existing, worktree, ref)
    if (ref?.external && !identical) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        "Can't move an existing workspace under a parent whose chain reaches another Orca install. Create the new workspace from that parent instead, or clear its parent first."
      )
    }
    if (!identical) {
      const parent = await args.ports.resolveWorktree(
        lineage.parentWorktree ?? `id:${ref?.worktreeId}`,
        ref?.instanceId
      )
      facts = readWorktreeLineageCorpus(args.store)
      target = worktreeRowTarget(args.store, { id: worktree.id, hostId: executionHostId })
      if (
        !target ||
        !facts.hasCurrent(worktree) ||
        !facts.hasCurrent(parent) ||
        (ref && parent.instanceId !== ref.instanceId)
      ) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_INSTANCE_STALE',
          'The parent workspace changed. Refresh and try again.'
        )
      }
      existingLineage = facts.edgeOf(worktree)
      previousParentRepoId = splitWorktreeId(existingLineage?.parentWorktreeId ?? '')?.repoId
      const sameSavedParent = isSameSavedWorktreeParent(existingLineage, worktree, {
        worktreeId: parent.id,
        instanceId: parent.instanceId,
        external: !sharesWorktreeLineageBoundary(worktree, parent)
      })
      if (!sameSavedParent) {
        args.ports.validateParent(worktree, parent)
        nextParentRepoId = parent.repoId
        if (!worktree.instanceId || !parent.instanceId) {
          throw new RuntimeLineageError(
            'LINEAGE_PARENT_CONTEXT_MISSING',
            'Worktree instance identity was unavailable.'
          )
        }
        if (
          worktree.id.startsWith('folder:')
            ? !args.store.setWorkspaceLineage
            : !args.store.setWorktreeLineage
        ) {
          throw new RuntimeLineageError(
            'LINEAGE_PARENT_CONTEXT_MISSING',
            'Worktree lineage storage was unavailable.'
          )
        }
        const createdAt = Date.now()
        const recorded =
          worktree.id.startsWith('folder:') ||
          args.store.setWorktreeLineage?.(target, {
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
          childWorkspaceKey: childKey,
          childInstanceId: worktree.instanceId,
          parentWorkspaceKey: parent.id.startsWith('folder:')
            ? `folder:${parent.id.slice(7)}`
            : worktreeWorkspaceKey(parent.id),
          parentInstanceId: parent.instanceId,
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt
        })
      }
    }
  }
  const metadataUpdates = stripOrcaProvenanceMetaUpdates(persisted)
  // Why: a resolution snapshot taken before a removal still returns the workspace (#22712).
  if (isRemovedFolderWorkspaceInstance(args.store, worktree.id, executionHostId)) {
    throw new Error('selector_not_found')
  }
  if (!worktree.id.startsWith('folder:')) {
    args.store.setWorktreeMeta(target, metadataUpdates)
  }
  // Why: CLI callers need an explicit push for metadata changed outside the renderer's optimistic update path.
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
  // A moving project keeps its old order; the rest of the batch still lands. Only what was saved
  // is reported and published.
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
