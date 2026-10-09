import type { GitPushTarget, Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeId } from '../../shared/worktree/id'
import { planWorktreeSortOrderUpdates } from '../../shared/worktree/sort-order-update'
import { getWorktreeInstanceId } from '../../shared/worktree/identity'
import { stripOrcaProvenanceMetaUpdates } from '../worktree-removal-safety'
import type { RuntimeStore } from './runtime-store-contract'
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
  assertCurrentMetadata(args.store, worktree, args.updates)
  const { lineage, ...metaUpdates } = args.updates
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
    args.store.removeWorktreeLineage?.(worktree.id)
    args.store.removeWorkspaceLineage?.(worktreeWorkspaceKey(worktree.id))
  } else if (lineage?.parentWorktree) {
    const parent = await args.ports.resolveWorktree(lineage.parentWorktree)
    assertCurrentMetadata(args.store, worktree, args.updates)
    assertCurrentMetadata(args.store, parent)
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
    const createdAt = Date.now()
    args.store.setWorktreeLineage(worktree.id, {
      worktreeId: worktree.id,
      worktreeInstanceId: worktree.instanceId,
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: parent.instanceId,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt
    })
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
  const meta = args.store.updateExistingWorktreeMeta?.(worktree.id, metadataUpdates, {
    executionHostId: worktree.identity?.executionHostId ?? worktree.hostId,
    instanceId: getWorktreeInstanceId(worktree)
  })
  if (!meta) {
    throw new Error('selector_not_found')
  }
  // Why: CLI callers need an explicit push for metadata changed outside the renderer's optimistic update path.
  args.ports.invalidateResolved()
  args.ports.notifyChanged(worktree.repoId)
  return args.ports.showWorktree(
    worktree.identity ? `identity:${worktree.identity.key}` : args.selector
  )
}

function assertCurrentMetadata(
  store: RuntimeStore,
  worktree: ResolvedWorktree,
  updates: Partial<Pick<WorktreeMeta, 'hostId' | 'instanceId'>> = {}
): void {
  if (
    !store.isCurrentWorktreeMetadata?.(
      worktree.id,
      {
        executionHostId: worktree.identity?.executionHostId ?? worktree.hostId,
        instanceId: getWorktreeInstanceId(worktree)
      },
      updates
    )
  ) {
    throw new Error('selector_not_found')
  }
}

export function persistRuntimeManagedWorktreeSortOrder(args: {
  orderedIds: string[]
  store: RuntimeStore
  invalidateResolved: () => void
  notifyChanged: (repoId: string) => void
}): { updated: number } {
  const updates = planWorktreeSortOrderUpdates(
    args.orderedIds,
    (worktreeId) => args.store.getWorktreeMeta(worktreeId),
    Date.now()
  )
  const accepted =
    args.store.updateExistingWorktreeMetaBatch?.(
      updates.map((update) => ({
        worktreeId: update.worktreeId,
        updates: { sortOrder: update.sortOrder }
      }))
    ) ?? []
  if (accepted.length === 0) {
    return { updated: 0 }
  }
  args.invalidateResolved()
  const repoIds = new Set(
    accepted.flatMap((worktreeId) => {
      const parsed = splitWorktreeId(worktreeId)
      return parsed ? [parsed.repoId] : []
    })
  )
  for (const repoId of repoIds) {
    args.notifyChanged(repoId)
  }
  return { updated: accepted.length }
}

function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}
