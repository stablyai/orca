import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { ownedEditorFileId } from '../../shared/workspace-session-pane-ownership'

type OwnerProjection = {
  mapOwnerKey: (ownerKey: string) => string | null
  mapWorktreeId: (worktreeId: string) => string
}

export function mapMarkdownFrontmatterVisible(
  visibleByFileId: Record<string, boolean> | undefined,
  filesByOwner: WorkspaceSessionState['openFilesByWorktree'] | undefined,
  projection: OwnerProjection
): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  const sourceToDestination = buildMarkdownFrontmatterIdMap(filesByOwner, projection)
  for (const [sourceFileId, visible] of Object.entries(visibleByFileId ?? {})) {
    if (visible) {
      // Visible is the hydration default; carry only hidden overrides.
      continue
    }
    const destinationId = sourceToDestination.get(sourceFileId)
    if (destinationId) {
      next[destinationId] = false
    }
  }
  return next
}

/** Null marks IDs claimed by multiple transferred files; never guess visibility ownership. */
export function buildMarkdownFrontmatterIdMap(
  filesByOwner: WorkspaceSessionState['openFilesByWorktree'] | undefined,
  projection: OwnerProjection
): ReadonlyMap<string, string | null> {
  const result = new Map<string, string | null>()
  for (const [sourceOwnerKey, files] of Object.entries(filesByOwner ?? {})) {
    if (!projection.mapOwnerKey(sourceOwnerKey)) {
      continue
    }
    const destinationWorktreeId = projection.mapWorktreeId(sourceOwnerKey)
    const sourceWorktreeIds = [sourceOwnerKey]
    const separator = sourceOwnerKey.indexOf('|')
    if (separator > 0) {
      sourceWorktreeIds.push(sourceOwnerKey.slice(separator + 1))
    }
    for (const file of files) {
      const destinationId = ownedEditorFileId(
        file.filePath,
        destinationWorktreeId,
        file.runtimeEnvironmentId
      )
      for (const sourceWorktreeId of sourceWorktreeIds) {
        const candidates = markdownFileIdCandidates(
          file.filePath,
          sourceWorktreeId,
          file.runtimeEnvironmentId
        )
        for (const sourceId of candidates) {
          const mapped = sourceId === file.filePath ? file.filePath : destinationId
          const existing = result.get(sourceId)
          result.set(sourceId, existing === undefined || existing === mapped ? mapped : null)
        }
      }
    }
  }
  return result
}

/** IDs hydration can assign before runtime data loads. */
export function markdownFileIdCandidates(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): ReadonlySet<string> {
  return new Set([filePath, ownedEditorFileId(filePath, worktreeId, runtimeEnvironmentId)])
}
