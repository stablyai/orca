// Main moves editor tabs across partitions and writes only changed records, retaining in-memory views.

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
  /** In-memory views may be absent for this partition. */
  views?: PartitionEditorViews
}

export type CrossPartitionTabMove = {
  value: LayoutApplyOutcome
  /** Null means no session changes. */
  sessions: { from: WorkspaceSessionState; to: WorkspaceSessionState } | null
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

/** Patch changed loaded records back into stored form. */
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
  // Include both partitions so generated tab IDs cannot collide in either.
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
