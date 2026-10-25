import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { OrcadMigrationTerminalScrollbackSnapshot } from '../../../shared/orcad-migration/orcad-migration-scrollback'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { keepUnsavedDrafts } from '../../../shared/workspace-session-draft-retention'
import {
  filterWorkspaceRows,
  withoutWorkspaces
} from '../../../shared/workspace-session-stranded-partition-adoption'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  orcadMigrationPartitionScope
} from './orcad-source-scope'
import { unsavedDraftItems, worktreeLabel } from './orcad-source-workspace-session-eligibility'

// What "Move anyway" does with the desktop's own copy of a moving host's saved session.

export type SessionFragment = {
  session: WorkspaceSessionState
  snapshots: OrcadMigrationTerminalScrollbackSnapshot[]
  local: boolean
  sourceHost: boolean
}

/** Unsaved drafts in this desktop's own session for the source's worktrees. */
export function desktopDrafts(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload
): string[] {
  const scope = orcadMigrationPartitionScope(
    createOrcadMigrationSourceScope({ source, catalog, repos: state.repos }),
    LOCAL_EXECUTION_HOST_ID
  )
  return Object.entries(state.workspaceSession.openFilesByWorktree ?? {}).flatMap(
    ([ownerKey, files]) =>
      orcadMigrationOwnerMatchesScope(ownerKey, scope) ? unsavedDraftItems(files, ownerKey) : []
  )
}

/**
 * The desktop's copy of each conflicting worktree gives way to the host's, keeping its unsaved
 * drafts. Two different drafts of one file can't both move, so those still refuse.
 */
export function resolveCopiesForHost(
  fragments: readonly SessionFragment[],
  conflicting: ReadonlySet<string>
): { fragments: SessionFragment[]; clashingDrafts: string[] } {
  const desktop = fragments.filter((fragment) => fragment.local)
  const desktopRows = desktop.map((fragment) =>
    filterWorkspaceRows(fragment.session, (workspaceId) => conflicting.has(workspaceId))
  )
  const clashingDrafts: string[] = []
  if (!fragments.some((fragment) => fragment.sourceHost)) {
    // No host copy to carry them, so the desktop's drafts would have nowhere to go.
    for (const rows of desktopRows) {
      for (const [ownerKey, files] of Object.entries(rows.openFilesByWorktree ?? {})) {
        clashingDrafts.push(...unsavedDraftItems(files, ownerKey))
      }
    }
  }
  const resolved = fragments.map((fragment): SessionFragment => {
    if (fragment.local) {
      const session = withoutWorkspaces(fragment.session, conflicting)
      const layouts = new Set(Object.keys(session.terminalLayoutsByTabId))
      return {
        ...fragment,
        session,
        snapshots: fragment.snapshots.filter((snapshot) => layouts.has(snapshot.tabId))
      }
    }
    if (!fragment.sourceHost) {
      return fragment
    }
    const session = structuredClone(fragment.session)
    for (const rows of desktopRows) {
      for (const [ownerKey, files] of Object.entries(rows.openFilesByWorktree ?? {})) {
        const hostFiles = new Map(
          (session.openFilesByWorktree?.[ownerKey] ?? []).map((file) => [file.filePath, file])
        )
        for (const file of files) {
          const held = hostFiles.get(file.filePath)
          if (
            file.dirtyDraftContent !== undefined &&
            held?.dirtyDraftContent !== undefined &&
            held.dirtyDraftContent !== file.dirtyDraftContent
          ) {
            clashingDrafts.push(
              `two different unsaved versions of ${file.filePath} in ${worktreeLabel(ownerKey)}`
            )
          }
        }
      }
      keepUnsavedDrafts(session, rows)
    }
    return { ...fragment, session }
  })
  return { fragments: resolved, clashingDrafts }
}
