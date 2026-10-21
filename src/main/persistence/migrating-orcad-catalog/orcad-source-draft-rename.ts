/**
 * Unsaved editor drafts never leave this desktop. Its own session holds each one per host
 * partition, file path and disk baseline; a committed move renames the record from the SSH host
 * to its server, and restore lays it over the file and warns when the baseline no longer matches.
 */
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  orcadMigrationPartitionScope,
  unqualifyOrcadMigrationOwnerKey
} from './orcad-source-scope'
import { orcadMigrationSessionPartitions } from './orcad-source-session-partitions'

/** Destination worktree key → the drafted files it gains, as the server names that worktree. */
export type OrcadMigrationSourceDrafts = Record<string, PersistedOpenFile[]>

/** Another host's file stays that host's record; the move cannot rename it. */
export function isHostBoundOpenFile(file: PersistedOpenFile): boolean {
  return file.externalSshTargetId !== undefined || Boolean(file.runtimeEnvironmentId)
}

export function collectOrcadMigrationSourceDrafts(
  state: PersistedState,
  manifest: Pick<OrcadMigrationManifest, 'source' | 'payload'>
): OrcadMigrationSourceDrafts {
  const sourceScope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  // The host's own copy first: where both hold one file, it is the one the app reads.
  const partitions = orcadMigrationSessionPartitions(state, sourceScope).sort(
    ([a], [b]) => Number(b === sourceScope.hostId) - Number(a === sourceScope.hostId)
  )
  const drafts = new Map<string, Map<string, PersistedOpenFile>>()
  for (const [partitionId, session] of partitions) {
    const scope = orcadMigrationPartitionScope(sourceScope, partitionId)
    for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
      if (!orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
        continue
      }
      const key = unqualifyOrcadMigrationOwnerKey(ownerKey)
      for (const file of files) {
        if (file.dirtyDraftContent === undefined || isHostBoundOpenFile(file)) {
          continue
        }
        const byPath = drafts.get(key) ?? new Map<string, PersistedOpenFile>()
        drafts.set(key, byPath)
        if (!byPath.has(file.filePath)) {
          byPath.set(file.filePath, { ...structuredClone(file), worktreeId: key })
        }
      }
    }
  }
  return Object.fromEntries([...drafts].map(([key, byPath]) => [key, [...byPath.values()]]))
}

/**
 * The destination partition with each draft added, or null when nothing changes. A file the
 * destination already lists keeps its own record, so a draft discarded there never comes back.
 */
export function withRenamedOrcadMigrationDrafts(
  destination: WorkspaceSessionState,
  drafts: OrcadMigrationSourceDrafts,
  destinationEnvironmentId: string
): WorkspaceSessionState | null {
  const openFilesByWorktree = { ...destination.openFilesByWorktree }
  let changed = false
  for (const [key, files] of Object.entries(drafts)) {
    const held = openFilesByWorktree[key] ?? []
    const heldPaths = new Set(held.map((file) => file.filePath))
    // Owned by the server now, so reads, saves and its mirrored tab all resolve to it.
    const added = files
      .filter((file) => !heldPaths.has(file.filePath))
      .map((file) => ({ ...file, runtimeEnvironmentId: destinationEnvironmentId }))
    if (added.length > 0) {
      openFilesByWorktree[key] = [...held, ...added]
      changed = true
    }
  }
  return changed ? { ...destination, openFilesByWorktree } : null
}

/** The session the server is sent: tabs without their unsaved contents. */
export function withoutOrcadMigrationDrafts(session: WorkspaceSessionState): WorkspaceSessionState {
  if (!session.openFilesByWorktree) {
    return session
  }
  return {
    ...session,
    openFilesByWorktree: Object.fromEntries(
      Object.entries(session.openFilesByWorktree).map(([key, files]) => [
        key,
        files.map(({ dirtyDraftContent: _draft, lastKnownDiskSignature: _base, ...file }) => file)
      ])
    )
  }
}
