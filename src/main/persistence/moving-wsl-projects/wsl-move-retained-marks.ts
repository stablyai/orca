/**
 * Writes the `orcadRetained` mark on local project rows (mover design, section 4.5). Only this
 * machine's rows: the WSL host's own row carries the same id and is never marked.
 */
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import {
  sameOrcadRetainedMarker,
  type OrcadRetainedMarker
} from '../../../shared/orcad-retained-marker'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import { isLocalWslMoveRow } from './wsl-move-scope-guard'

/** `marker: null` removes the mark. */
export type WslMoveRetainedMark = {
  kind: 'repo' | 'folder'
  id: string
  marker: OrcadRetainedMarker | null
}

/** Mutates the rows in place; returns how many changed so the caller saves only when needed. */
export function applyWslMoveRetainedMarks(
  state: Pick<PersistedState, 'repos' | 'folderWorkspaces'>,
  marks: readonly WslMoveRetainedMark[]
): number {
  let changed = 0
  for (const mark of marks) {
    const rows: readonly (Repo | FolderWorkspace)[] =
      mark.kind === 'repo' ? state.repos : (state.folderWorkspaces ?? [])
    const row = rows.find((entry) => entry.id === mark.id && isLocalWslMoveRow(entry))
    const next = mark.marker ?? undefined
    if (!row || sameOrcadRetainedMarker(row.orcadRetained, next)) {
      continue
    }
    if (next) {
      row.orcadRetained = { ...next }
    } else {
      delete row.orcadRetained
    }
    changed++
  }
  return changed
}
