import type { GitPushTarget, Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeId } from '../../shared/worktree/id'
import { planWorktreeSortOrderUpdates } from '../../shared/worktree/sort-order-update'
import {
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHost
} from '../../shared/folder-workspace-execution-host'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../shared/execution-host'
import { stripOrcaProvenanceMetaUpdates } from '../worktree-removal-safety'
import type { RuntimeStore } from './runtime-store-contract'
import {
  RuntimeLineageError,
  type ResolvedWorkspaceParent
} from './runtime-worktree-lineage-resolution'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

type Updates = Omit<Partial<WorktreeMeta>, 'pushTarget'> & {
  pushTarget?: GitPushTarget | null
  lineage?: { parentWorktree?: string; noParent?: boolean }
}

type Ports = {
  resolveWorktree: (selector: string) => Promise<ResolvedWorktree>
  resolveParent: (selector: string) => Promise<ResolvedWorkspaceParent>
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
    const parent = await args.ports.resolveParent(lineage.parentWorktree)
    if (parent.type === 'folder') {
      // Why: a folder workspace has no repo or project, so the worktree boundary
      // rules do not apply — but the hosts must match, or the folder view could
      // never show the row it now claims.
      const hostConflict = describeFolderParentHostConflict(
        resolveFolderWorkspaceHost(
          {
            folderWorkspaces: [parent.folderWorkspace],
            projectGroups: args.store.getProjectGroups?.() ?? [],
            repos: args.store.getRepos()
          },
          parent.folderWorkspace.id
        ),
        worktree
      )
      if (hostConflict) {
        throw new RuntimeLineageError('LINEAGE_PARENT_CONTEXT_CONFLICT', hostConflict)
      }
      if (!worktree.instanceId) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CONTEXT_MISSING',
          'Worktree instance identity was unavailable.'
        )
      }
      if (!args.store.setWorkspaceLineage) {
        throw new RuntimeLineageError(
          'LINEAGE_PARENT_CONTEXT_MISSING',
          'Workspace lineage storage was unavailable.'
        )
      }
      // A folder parent replaces any worktree parent: workspace lineage is the only edge.
      args.store.removeWorktreeLineage?.(worktree.id)
      args.store.setWorkspaceLineage({
        childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
        childInstanceId: worktree.instanceId,
        parentWorkspaceKey: parent.workspaceKey,
        parentInstanceId: parent.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: Date.now()
      })
    } else {
      args.ports.validateParent(worktree, parent.worktree)
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
        parentWorktreeId: parent.worktree.id,
        parentWorktreeInstanceId: parent.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt
      })
      args.store.setWorkspaceLineage?.({
        childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
        childInstanceId: worktree.instanceId,
        parentWorkspaceKey: parent.workspaceKey,
        parentInstanceId: parent.instanceId,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt
      })
    }
  }
  const metadataUpdates = stripOrcaProvenanceMetaUpdates(persisted)
  const executionHostId = worktree.identity?.executionHostId ?? worktree.hostId
  if (executionHostId && args.store.setWorktreeMetaForHost) {
    args.store.setWorktreeMetaForHost(worktree.id, executionHostId, metadataUpdates)
  } else {
    args.store.setWorktreeMeta(worktree.id, metadataUpdates)
  }
  // Why: CLI callers need an explicit push for metadata changed outside the renderer's optimistic update path.
  args.ports.invalidateResolved()
  args.ports.notifyChanged(worktree.repoId)
  return args.ports.showWorktree(`id:${worktree.id}`)
}

// Folder lookup is scoped to this runtime's store, which persists connectionId, not renderer
// runtime stamps. Compare local/SSH ownership here; this runtime's local/runtime aliases agree.
function describeFolderParentHostConflict(
  folderHost: FolderWorkspaceHost,
  worktree: ResolvedWorktree
): string | null {
  if (folderHost.kind === 'missing') {
    return 'Parent folder workspace could not be resolved to an execution host.'
  }
  if (folderHost.kind === 'ambiguous') {
    return 'Parent folder workspace spans more than one execution host.'
  }
  const worktreeHost = parseExecutionHostId(
    worktree.identity?.executionHostId ?? worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
  )
  const worktreeTargetId = worktreeHost?.kind === 'ssh' ? worktreeHost.targetId : null
  const folderTargetId = folderHost.kind === 'ssh' ? folderHost.targetId : null
  return worktreeTargetId === folderTargetId
    ? null
    : 'Parent folder workspace must belong to the same execution host.'
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
  for (const update of updates) {
    args.store.setWorktreeMeta(update.worktreeId, { sortOrder: update.sortOrder })
  }
  if (updates.length === 0) {
    return { updated: 0 }
  }
  args.invalidateResolved()
  const repoIds = new Set(
    updates.flatMap(({ worktreeId }) => {
      const parsed = splitWorktreeId(worktreeId)
      return parsed ? [parsed.repoId] : []
    })
  )
  for (const repoId of repoIds) {
    args.notifyChanged(repoId)
  }
  return { updated: updates.length }
}

function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}
