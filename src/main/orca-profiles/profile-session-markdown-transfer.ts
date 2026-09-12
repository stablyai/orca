import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

type OwnerProjection = {
  mapOwnerKey: (ownerKey: string) => string | null
  mapWorktreeId: (worktreeId: string) => string
}

/** Map file-keyed markdown visibility along with the persisted open-file identity it belongs to. */
export function mapMarkdownFrontmatterVisible(
  visibleByFileId: Record<string, boolean> | undefined,
  filesByOwner: WorkspaceSessionState['openFilesByWorktree'] | undefined,
  projection: OwnerProjection
): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  const sourceToDestination = buildMarkdownFrontmatterIdMap(filesByOwner, projection)
  for (const [sourceFileId, visible] of Object.entries(visibleByFileId ?? {})) {
    if (visible) {
      // Visible is the hydration default; preserving only hidden overrides avoids carrying stale
      // positive entries while retaining the exact rendered result.
      continue
    }
    const destinationId = sourceToDestination.get(sourceFileId)
    if (destinationId) {
      next[destinationId] = false
    }
  }
  return next
}

/**
 * Builds the file-id mapping used by hydration, marking a source id null when two transferred
 * files claim it. An ambiguous visibility override is never guessed at by the migration.
 */
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

/** Returns the IDs hydration can assign to a persisted file before any runtime data is loaded. */
export function markdownFileIdCandidates(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): ReadonlySet<string> {
  return new Set([filePath, ownedEditorFileId(filePath, worktreeId, runtimeEnvironmentId)])
}

function ownedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeEnvironmentId?.trim() || 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}
