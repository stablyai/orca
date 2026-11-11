import { getRepoRegistrationHostIds } from '../../../../shared/repo-host-identity'
import type { GitPushTarget, Worktree } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import type { WorktreeSortOrderUpdate } from '../../../../shared/worktree/sort-order-update'
import { stripOrcaProvenanceMetaUpdates } from '../../../workspaces/removal/worktree-removal-safety'
import { isRemovedFolderWorkspaceInstance } from '../../../workspaces/catalog/folder-workspace-meta-presence'
import { worktreeRowTarget } from '../../../persistence/host-qualified-worktree-meta'
import {
  writeWorktreeSortOrder,
  type WorktreeSortOrderRequest
} from '../../../persistence/worktree-sort-order-write'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  isWslMoveSourceHost,
  isWslMoveWorkspaceBlocked,
  shouldDropWslMoveProjectUpdate,
  wslMoveProjectRefForWorkspace
} from '../../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { RuntimeLineageError, explicitParentError } from '../lineage/runtime-lineage-error'
import type { ResolvedWorkspaceParent } from '../lineage/runtime-worktree-lineage-resolution'
import { assertParentInAnotherStore } from '../lineage/cross-store-parent-store-check'
import type { CrossStoreParentRef } from '../../../../shared/worktree/lineage-types'
import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'

type Updates = Omit<Partial<WorktreeMeta>, 'pushTarget'> & {
  pushTarget?: GitPushTarget | null
  lineage?: {
    parentWorktree?: string
    /** path: and name: in parentWorktree may name a folder workspace. */
    matchFolderWorkspaces?: boolean
    crossStoreParent?: CrossStoreParentRef
    noParent?: boolean
  }
}

type Ports = {
  resolveWorktree: (selector: string) => Promise<ResolvedWorktree>
  /** The parent by its real kind; throws `selector_not_found` when absent. */
  resolveParent: (
    selector: string,
    options: { matchFolders: boolean }
  ) => Promise<ResolvedWorkspaceParent>
  validateParent: (worktree: ResolvedWorktree, parent: ResolvedWorktree) => void
  readStoreInstallationId?: () => Promise<string | undefined>
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
  const folderParent = lineage?.parentWorktree ? folderParentKey(lineage.parentWorktree) : undefined
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
  if (lineage?.parentWorktree && !folderParent) {
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
  } else if (lineage?.crossStoreParent) {
    // Trusted like any paired mutation, unverified here: a forged ref only nests falsely and readers drop cycles.
    await assertParentInAnotherStore(
      lineage.crossStoreParent,
      async () => await args.ports.readStoreInstallationId?.()
    )
    if (!worktree.instanceId || !args.store.setCrossStoreWorkspaceLineage) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_MISSING',
        'Worktree instance identity or lineage storage was unavailable.'
      )
    }
    const recorded = args.store.setCrossStoreWorkspaceLineage(
      {
        childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
        childInstanceId: worktree.instanceId,
        parent: lineage.crossStoreParent,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: Date.now()
      },
      target.hostId
    )
    if (!recorded) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'A same-id workspace on another host owns this lineage.'
      )
    }
  } else if (lineage?.parentWorktree) {
    const parent = await args.ports
      .resolveParent(lineage.parentWorktree, {
        matchFolders: lineage.matchFolderWorkspaces === true
      })
      .catch((error: unknown) => {
        throw explicitParentError(error)
      })
    const recorded =
      parent.type === 'folder'
        ? recordFolderParent(args.store, target, worktree, parent)
        : recordWorktreeParent(args, target, worktree, parent.worktree)
    if (parent.type === 'worktree') {
      nextParentRepoId = parent.worktree.repoId
    }
    if (!recorded) {
      throw new RuntimeLineageError(
        'LINEAGE_PARENT_CONTEXT_CONFLICT',
        'A same-id workspace on another host owns this lineage.'
      )
    }
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

type HostTarget = NonNullable<ReturnType<typeof worktreeRowTarget>>

// A folder parent may live on a different host from its child; only a unique folder id is required.
function recordFolderParent(
  store: RuntimeStore,
  target: HostTarget,
  worktree: ResolvedWorktree,
  parent: Extract<ResolvedWorkspaceParent, { type: 'folder' }>
): unknown {
  if (!worktree.instanceId || !store.setFolderParentLineage) {
    throw new RuntimeLineageError(
      'LINEAGE_PARENT_CONTEXT_MISSING',
      'Worktree instance identity or lineage storage was unavailable.'
    )
  }
  return store.setFolderParentLineage(target, {
    childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
    childInstanceId: worktree.instanceId,
    parentWorkspaceKey: folderWorkspaceKey(parent.folderWorkspace.id),
    parentInstanceId: parent.folderWorkspace.id,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: Date.now()
  })
}

function recordWorktreeParent(
  args: { store: RuntimeStore; ports: Ports },
  target: HostTarget,
  worktree: ResolvedWorktree,
  parent: ResolvedWorktree
): unknown {
  args.ports.validateParent(worktree, parent)
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
  return args.store.setWorktreeLineage(target, {
    worktreeId: worktree.id,
    worktreeInstanceId: worktree.instanceId,
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: Date.now()
  })
}

function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}

/** `folder:<id>` or `id:folder:<id>` names a multi-repo folder workspace parent. */
function folderParentKey(selector: string): string | undefined {
  const raw = selector.startsWith('id:') ? selector.slice(3) : selector
  return parseWorkspaceKey(raw)?.type === 'folder' ? raw : undefined
}
