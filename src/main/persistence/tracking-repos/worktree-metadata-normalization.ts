import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  areTaskSourceContextsEqual,
  normalizeStoredTaskSourceContext
} from '../../../shared/task-source-context'
import {
  areWorkspaceLinkedItemsEqual,
  normalizeWorkspaceLinkedItem
} from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  pruneUnreferencedWorktreeIdentityMeta,
  removeWorktreeMetadataForHost
} from '../loading-store/worktree-identity-metadata'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { fillDefaultWorktreeMetaFields } from '../../../shared/worktree/meta-persisted-defaults'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments'
import { rehomeLocalOnlyWorktreeMetadata } from '../loading-store/local-only-worktree-meta-rehoming'

// Reclaim externally deleted local checkouts after idle grace; local stat cannot judge remote/WSL paths.
export const WORKTREE_META_GC_GRACE_MS = 30 * 24 * 60 * 60 * 1000
export const STALE_DURABLE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export function gcStaleWorktreeMeta(state: PersistedState): number {
  // Corrupt null maps override merged defaults and would throw during companion deletion.
  state.worktreeMeta ??= {}
  state.worktreeLineageById ??= {}
  state.workspaceLineageByChildKey ??= {}
  const repoById = new Map(state.repos.map((repo) => [repo.id, repo]))
  const projectIds = new Set((state.projects ?? []).map((project) => project.id))
  const now = Date.now()
  let removed = 0
  for (const key of Object.keys(state.worktreeMeta)) {
    // Folder-workspace instance keys are workspace records, not checkout metadata.
    if (key.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
      continue
    }
    const separator = key.indexOf('::')
    if (separator === -1) {
      continue
    }
    const ownerId = key.slice(0, separator)
    const worktreePath = key.slice(separator + 2)
    const meta = state.worktreeMeta[key]
    const repo = repoById.get(ownerId)
    if (repo) {
      if (repo.connectionId || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
        continue
      }
    } else if (projectIds.has(ownerId)) {
      continue
    }
    if (meta?.hostId && meta.hostId !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    if (!isAbsolute(worktreePath) || isWslUncPath(worktreePath)) {
      continue
    }
    // Windows cannot probe Linux-spelled WSL paths with existsSync.
    if (process.platform === 'win32' && !isWindowsAbsolutePathLike(worktreePath)) {
      continue
    }
    // Missing timestamps cannot prove grace elapsed; check age before expensive/NFS stats.
    const newestTouch = Math.max(meta?.lastActivityAt ?? 0, meta?.createdAt ?? 0)
    if (newestTouch === 0 || now - newestTouch < WORKTREE_META_GC_GRACE_MS) {
      continue
    }
    if (existsSync(worktreePath)) {
      continue
    }
    delete state.worktreeMeta[key]
    delete state.worktreeLineageById[key]
    delete state.workspaceLineageByChildKey[worktreeWorkspaceKey(key)]
    // Remove identity aliases too or future worktrees at the same path could inherit dead metadata.
    removeWorktreeMetadataForHost(state, key, LOCAL_EXECUTION_HOST_ID)
    removed++
  }
  return removed
}

function normalizeLinkedMetadata(meta: WorktreeMeta): boolean {
  const linkedWorkItem = normalizeWorkspaceLinkedItem(meta.linkedWorkItem)
  const sourceContext = normalizeStoredTaskSourceContext(meta.linkedTaskSourceContext)
  const linkedTaskSourceContext = isWorkspaceLinkedItemSourceContextMatch(
    linkedWorkItem,
    sourceContext
  )
    ? sourceContext
    : null
  let changed = false
  const linkedItems = getWorkspaceAttachments(meta)
  if (
    meta.linkedItems !== undefined &&
    JSON.stringify(meta.linkedItems) !== JSON.stringify(linkedItems)
  ) {
    meta.linkedItems = linkedItems
    changed = true
  }
  if (!areWorkspaceLinkedItemsEqual(meta.linkedWorkItem, linkedWorkItem)) {
    meta.linkedWorkItem = linkedWorkItem
    changed = true
  }
  if (!areTaskSourceContextsEqual(meta.linkedTaskSourceContext, linkedTaskSourceContext)) {
    meta.linkedTaskSourceContext = linkedTaskSourceContext
    changed = true
  }
  return changed
}

export function normalizeWorktreeLinkedItemMetadata(state: PersistedState): boolean {
  // Mark null-map repairs dirty or they recur on every load.
  let changed =
    (state.worktreeLineageById as unknown) === null ||
    (state.workspaceLineageByChildKey as unknown) === null
  state.worktreeLineageById ??= {}
  state.workspaceLineageByChildKey ??= {}
  const rawWorktreeMeta = state.worktreeMeta as unknown
  if (
    typeof rawWorktreeMeta !== 'object' ||
    rawWorktreeMeta === null ||
    Array.isArray(rawWorktreeMeta)
  ) {
    const hadLineage =
      Object.keys(state.worktreeLineageById).length > 0 ||
      Object.keys(state.workspaceLineageByChildKey).length > 0
    state.worktreeMeta = {}
    // Legacy lineage belongs to the discarded locator projection; canonical host state does not.
    state.worktreeLineageById = {}
    state.workspaceLineageByChildKey = {}
    changed ||= rawWorktreeMeta !== undefined || hadLineage
  }
  for (const [key, meta] of Object.entries(state.worktreeMeta)) {
    // Drop corrupt rows; GC retains timestamp-less entries and typed consumers assume metadata objects.
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      delete state.worktreeMeta[key]
      // Legacy lineage belongs to this corrupt locator row; canonical host state is independent.
      delete state.worktreeLineageById[key]
      delete state.workspaceLineageByChildKey[worktreeWorkspaceKey(key)]
      changed = true
      continue
    }
    // Restoring serializer-omitted defaults is canonical, so it must not trigger a full rewrite.
    fillDefaultWorktreeMetaFields(meta)
    changed = normalizeLinkedMetadata(meta) || changed
  }
  const rawIdentityMetadata = state.worktreeMetaByIdentity as unknown
  if (
    rawIdentityMetadata !== undefined &&
    (typeof rawIdentityMetadata !== 'object' ||
      rawIdentityMetadata === null ||
      Array.isArray(rawIdentityMetadata))
  ) {
    state.worktreeMetaByIdentity = {}
    changed = true
  }
  for (const [identityKey, meta] of Object.entries(state.worktreeMetaByIdentity ?? {})) {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      delete state.worktreeMetaByIdentity?.[identityKey]
      changed = true
      continue
    }
    fillDefaultWorktreeMetaFields(meta)
    changed = normalizeLinkedMetadata(meta) || changed
  }

  const rawAliases = state.worktreeIdentityAliases as unknown
  const aliasesAreObject =
    typeof rawAliases === 'object' && rawAliases !== null && !Array.isArray(rawAliases)
  const aliasesAreMalformed = rawAliases !== undefined && !aliasesAreObject
  const aliasesCanProveReachability = aliasesAreObject && Object.keys(rawAliases).length > 0
  if (aliasesAreMalformed) {
    state.worktreeIdentityAliases = {}
    changed = true
  }
  for (const [alias, rawIdentityKeys] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    if (!Array.isArray(rawIdentityKeys)) {
      delete state.worktreeIdentityAliases?.[alias]
      changed = true
      continue
    }
    // Dangling aliases cannot resolve and would make the next write ambiguous.
    const identityKeys = [
      ...new Set(
        rawIdentityKeys.filter(
          (key): key is string =>
            typeof key === 'string' &&
            key.length > 0 &&
            Boolean(state.worktreeMetaByIdentity?.[key])
        )
      )
    ]
    if (identityKeys.length === 0) {
      delete state.worktreeIdentityAliases?.[alias]
      changed = true
    } else if (
      identityKeys.length !== rawIdentityKeys.length ||
      identityKeys.some((key, index) => key !== rawIdentityKeys[index])
    ) {
      state.worktreeIdentityAliases ??= {}
      state.worktreeIdentityAliases[alias] = identityKeys
      changed = true
    }
  }
  changed = rehomeLocalOnlyWorktreeMetadata(state) || changed
  if (aliasesCanProveReachability) {
    changed = pruneUnreferencedWorktreeIdentityMeta(state) || changed
  }
  return changed
}
