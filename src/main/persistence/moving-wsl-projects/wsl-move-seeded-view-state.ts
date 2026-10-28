/**
 * This desktop's view state of a moved project that the manifest never carries, laid over the
 * host partition's seed: unsaved editor drafts (drafts stay on this desktop, as the SSH move's
 * draft rename keeps them), markdown frontmatter visibility (keyed by a UNC file id the export
 * cannot rewrite) and closed-terminal-tab tombstones. Only for workspaces seeded in this run, so
 * anything the user since changed on the host stays as it is.
 */
import type { ClosedTerminalTabTombstone } from '../../../shared/closed-terminal-tab-tombstones'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import { isHostBoundOpenFile } from '../migrating-orcad-catalog/orcad-source-draft-rename'
import type { WslMoveRewriteScope } from './wsl-move-rewrite-scope'

type ViewStateScope = Pick<WslMoveRewriteScope, 'inScope' | 'worktreeId' | 'path'> & {
  /** The environment the moved files open under on this desktop: their editor ids name it. */
  destinationEnvironmentId: string
}

type LocalViewState = Pick<
  WorkspaceSessionState,
  'openFilesByWorktree' | 'markdownFrontmatterVisible' | 'closedTerminalTabTombstonesByTabId'
>

/** `seed` with this desktop's view state of `seededWorkspaceIds` laid over it; null if unchanged. */
export function withWslMoveSeededViewState(
  seed: WorkspaceSessionState,
  local: LocalViewState,
  scope: ViewStateScope,
  seededWorkspaceIds: ReadonlySet<string>
): WorkspaceSessionState | null {
  const seeded = (owner: string): string | null => {
    if (!scope.inScope(owner)) {
      return null
    }
    const hostKey = scope.worktreeId(owner)
    return seededWorkspaceIds.has(hostKey) ? hostKey : null
  }
  const drafts = withDrafts(seed, local, scope, seeded)
  const frontmatter = withFrontmatter(seed, local, scope, seeded)
  const tombstones = withClosedTabTombstones(seed, local, seeded)
  if (!drafts && !frontmatter && !tombstones) {
    return null
  }
  return {
    ...seed,
    ...(drafts ? { openFilesByWorktree: drafts } : {}),
    ...(frontmatter ? { markdownFrontmatterVisible: frontmatter } : {}),
    ...(tombstones ? { closedTerminalTabTombstonesByTabId: tombstones } : {})
  }
}

type SeededKey = (owner: string) => string | null

function withDrafts(
  seed: WorkspaceSessionState,
  local: LocalViewState,
  scope: ViewStateScope,
  seeded: SeededKey
): WorkspaceSessionState['openFilesByWorktree'] | null {
  const openFilesByWorktree = { ...seed.openFilesByWorktree }
  let changed = false
  for (const [owner, files] of Object.entries(local.openFilesByWorktree ?? {})) {
    const hostKey = seeded(owner)
    if (!hostKey) {
      continue
    }
    for (const file of files) {
      if (file.dirtyDraftContent === undefined || isHostBoundOpenFile(file)) {
        continue
      }
      const hostPath = scope.path(file.filePath)
      const held = openFilesByWorktree[hostKey] ?? []
      const index = held.findIndex(
        (entry) => entry.filePath === hostPath && entry.dirtyDraftContent === undefined
      )
      if (index === -1) {
        continue
      }
      const next = [...held]
      // Owned by the host now, as the SSH move's draft rename makes it, so saves reach the host.
      next[index] = {
        ...held[index],
        runtimeEnvironmentId: scope.destinationEnvironmentId,
        dirtyDraftContent: file.dirtyDraftContent,
        ...(file.lastKnownDiskSignature !== undefined
          ? { lastKnownDiskSignature: file.lastKnownDiskSignature }
          : {})
      }
      openFilesByWorktree[hostKey] = next
      changed = true
    }
  }
  return changed ? openFilesByWorktree : null
}

/** `editor:<worktree>:<runtime>:<path>`, each part URI-encoded (ownedEditorFileId). */
function parseEditorFileId(
  id: string
): { worktreeId: string; runtimeKey: string; filePath: string } | null {
  const parts = id.split(':')
  if (parts.length !== 4 || parts[0] !== 'editor') {
    return null
  }
  try {
    const [worktreeId, runtimeKey, filePath] = parts.slice(1).map(decodeURIComponent)
    return { worktreeId, runtimeKey, filePath }
  } catch {
    return null
  }
}

function withFrontmatter(
  seed: WorkspaceSessionState,
  local: LocalViewState,
  scope: ViewStateScope,
  seeded: SeededKey
): Record<string, boolean> | null {
  const next = { ...seed.markdownFrontmatterVisible }
  let changed = false
  for (const [id, visible] of Object.entries(local.markdownFrontmatterVisible ?? {})) {
    const parsed = parseEditorFileId(id)
    // Another host's file keeps its own id; only this computer's files moved.
    const hostKey = parsed?.runtimeKey === 'local' ? seeded(parsed.worktreeId) : null
    if (!parsed || !hostKey) {
      continue
    }
    const hostId = ownedEditorFileId(
      scope.path(parsed.filePath),
      hostKey,
      scope.destinationEnvironmentId
    )
    if (!Object.hasOwn(next, hostId)) {
      next[hostId] = visible
      changed = true
    }
  }
  return changed ? next : null
}

function withClosedTabTombstones(
  seed: WorkspaceSessionState,
  local: LocalViewState,
  seeded: SeededKey
): Record<string, ClosedTerminalTabTombstone> | null {
  const next = { ...seed.closedTerminalTabTombstonesByTabId }
  let changed = false
  for (const [tabId, tombstone] of Object.entries(local.closedTerminalTabTombstonesByTabId ?? {})) {
    const hostKey = seeded(tombstone.worktreeId)
    if (hostKey && !Object.hasOwn(next, tabId)) {
      next[tabId] = { ...tombstone, worktreeId: hostKey }
      changed = true
    }
  }
  return changed ? next : null
}
