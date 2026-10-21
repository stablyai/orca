// Moving editor tabs between workspaces held in two partitions (a local and an SSH workspace):
// main reads both, moves the tabs as it would within one, and writes back only what each
// partition's records changed. A window save no longer carries the move.

import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  CommandOf,
  LayoutApplyOutcome
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { updateLegacyPersistence } from '../../../shared/workspace-layout/workspace-layout-legacy-persistence'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import type { LoadedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type {
  WorkspaceLayout,
  WorkspaceLayoutModel
} from '../../../shared/workspace-layout/workspace-layout-model'
import { patchStoredSession } from '../../../shared/workspace-layout/workspace-layout-record-patch'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { moveTabToWorkspace } from '../../../shared/workspace-layout/workspace-layout-workspace-move'
import { editorViewsOfModel, type PartitionEditorViews } from '../loading-store/layout-editor-views'

type PartitionSession = {
  hostId: ExecutionHostId
  session: WorkspaceSessionState
  /** Main's in-memory editor views (layout-editor-views); absent where none are kept. */
  views?: PartitionEditorViews
}

export type CrossPartitionTabMove = {
  value: LayoutApplyOutcome
  /** Each partition's session after the move; null when nothing changes. */
  sessions: { from: WorkspaceSessionState; to: WorkspaceSessionState } | null
  /** Each partition's views after the move, when seeded. */
  views?: { from: PartitionEditorViews; to: PartitionEditorViews }
}

function loadContext(partition: PartitionSession) {
  const { views } = partition
  return views
    ? { ...nameBasedLoadContext(), editorViewsOf: (key: string) => views[key] }
    : nameBasedLoadContext()
}

function withLoadedWorkspace(
  model: WorkspaceLayoutModel,
  key: string,
  workspace: WorkspaceLayout | undefined
): WorkspaceLayoutModel {
  const workspaces = { ...model.workspaces }
  if (workspace) {
    workspaces[key] = workspace
  } else {
    delete workspaces[key]
  }
  return { ...model, workspaces }
}

/** `stored` with only the records the move changed in its loaded partition rewritten. */
function written(
  stored: WorkspaceSessionState,
  loaded: LoadedWorkspaceLayout,
  after: WorkspaceLayoutModel
): WorkspaceSessionState {
  const layout = updateLegacyPersistence(loaded.layout, after)
  return patchStoredSession(
    stored,
    saveWorkspaceLayout(loaded),
    saveWorkspaceLayout({ ...loaded, layout })
  )
}

/** The move of `command` from its workspace in `from` to its target workspace in `to`. */
export function moveTabAcrossPartitions(
  from: PartitionSession,
  to: PartitionSession,
  command: CommandOf<'moveTabToWorkspace'>
): CrossPartitionTabMove {
  const loadedFrom = loadWorkspaceLayout(from.hostId, from.session, loadContext(from))
  const loadedTo = loadWorkspaceLayout(to.hostId, to.session, loadContext(to))
  if (!loadedFrom.layout.workspaces[command.workspace]) {
    return { value: { ok: false, code: 'workspace_not_found' }, sessions: null }
  }
  // Both partitions' workspaces, so a new tab id either one holds is refused.
  const joined = withLoadedWorkspace(
    {
      ...loadedFrom.layout,
      workspaces: { ...loadedTo.layout.workspaces, ...loadedFrom.layout.workspaces }
    },
    command.toWorkspace,
    loadedTo.layout.workspaces[command.toWorkspace]
  )
  const moved = moveTabToWorkspace(joined, command, {
    mintId: randomUUID,
    mintLeafId: randomUUID,
    now: Date.now
  })
  if (!moved.ok) {
    return { value: { ok: false, code: moved.code }, sessions: null }
  }
  const value: LayoutApplyOutcome = { ok: true, result: moved.result }
  if (moved.model === joined) {
    return { value, sessions: null }
  }
  const fromAfter = withLoadedWorkspace(
    loadedFrom.layout,
    command.workspace,
    moved.model.workspaces[command.workspace]
  )
  const toAfter = withLoadedWorkspace(
    loadedTo.layout,
    command.toWorkspace,
    moved.model.workspaces[command.toWorkspace]
  )
  return {
    value,
    sessions: {
      from: written(from.session, loadedFrom, fromAfter),
      to: written(to.session, loadedTo, toAfter)
    },
    ...(from.views && to.views
      ? { views: { from: editorViewsOfModel(fromAfter), to: editorViewsOfModel(toAfter) } }
      : {})
  }
}
