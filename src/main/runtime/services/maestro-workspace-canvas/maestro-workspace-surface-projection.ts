import {
  WorkspaceSurfaceSnapshotSchema,
  workspaceSurfaceKey,
  type WorkspaceSurfaceSnapshot
} from '../../../../shared/maestro-workspace-canvas'
import type {
  RuntimeMaestroWorkspaceCanvasScope,
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { WorkspaceCanvasDocument } from '../../../../shared/maestro-document-contract'

type WorkspaceCanvasClientTab = Exclude<RuntimeMobileSessionClientTab, { type: 'agent-session' }>

export function workspaceCanvasSelector(scope: RuntimeMaestroWorkspaceCanvasScope): string {
  const parsed = parseWorkspaceKey(scope.workspace_key)
  if (parsed?.type === 'folder') {
    return `id:${scope.workspace_key}`
  }
  if (parsed?.type === 'worktree') {
    return `id:${parsed.worktreeId}`
  }
  throw new Error('workspace_scope_unavailable')
}

function groupIdForTab(snapshot: RuntimeMobileSessionTabsResult, tabId: string): string {
  return (
    snapshot.tabGroups?.find((group) => group.tabOrder.includes(tabId))?.id ??
    snapshot.activeGroupId ??
    'ungrouped'
  )
}

function contentType(tab: WorkspaceCanvasClientTab): 'editor' | 'diff' {
  return tab.type === 'file' && tab.mode === 'diff' ? 'diff' : 'editor'
}

function projectSurface(
  scope: RuntimeMaestroWorkspaceCanvasScope,
  snapshot: RuntimeMobileSessionTabsResult,
  tab: WorkspaceCanvasClientTab,
  revision: number,
  resolveTerminalIncarnation: (terminalHandle: string) => string | null,
  annotations: WorkspaceCanvasDocument['annotations']
) {
  const unifiedTabId = tab.type === 'terminal' ? tab.parentTabId : tab.id
  const id = {
    execution_host_id: scope.execution_host_id,
    workspace_key: scope.workspace_key,
    unified_tab_id: unifiedTabId
  }
  const group_id = groupIdForTab(snapshot, unifiedTabId)
  if (tab.type === 'terminal') {
    return {
      id,
      content_type: 'terminal' as const,
      entity_id: tab.parentTabId,
      group_id,
      title: tab.title,
      revision,
      availability: 'available' as const,
      binding: {
        kind: 'terminal' as const,
        terminal_tab_id: tab.parentTabId,
        pane_key: tab.leafId,
        session_id: tab.ptyId ?? null,
        pty_incarnation: tab.status === 'ready' ? resolveTerminalIncarnation(tab.terminal) : null,
        liveness: 'live' as const,
        authority_revision: revision
      }
    }
  }
  if (tab.type === 'browser') {
    if (!tab.browserPageId) {
      throw new Error('browser_page_identity_unavailable')
    }
    return {
      id,
      content_type: 'browser' as const,
      entity_id: tab.browserWorkspaceId,
      group_id,
      title: tab.title,
      revision,
      availability: 'available' as const,
      binding: {
        kind: 'browser' as const,
        browser_workspace_id: tab.browserWorkspaceId,
        browser_page_id: tab.browserPageId,
        profile_id: null,
        partition_id: null,
        authority_revision: revision,
        live_frame: null,
        immutable_capture: null
      }
    }
  }
  const concreteType = contentType(tab)
  const modelRevision =
    tab.type === 'markdown'
      ? tab.documentVersion
      : `${snapshot.publicationEpoch}:${snapshot.snapshotVersion}`
  return {
    id,
    content_type: concreteType,
    entity_id: tab.id,
    group_id,
    title: tab.title,
    revision,
    availability: 'available' as const,
    binding: {
      kind: 'content' as const,
      entity_id: tab.id,
      content_type: concreteType,
      model_revision: modelRevision,
      owner_principal: 'runtime-session',
      read_only: false,
      source: {
        relative_path: tab.type === 'markdown' ? tab.sourceRelativePath : tab.relativePath,
        language: tab.language,
        mode: tab.type === 'markdown' ? tab.mode : (tab.mode ?? 'edit'),
        diff_source: tab.type === 'file' ? (tab.diffSource ?? null) : null,
        is_dirty: tab.isDirty
      },
      annotation: annotations[workspaceSurfaceKey(id)]
        ? {
            relative_path: annotations[workspaceSurfaceKey(id)].relative_path,
            tone: annotations[workspaceSurfaceKey(id)].tone
          }
        : null
    }
  }
}

export function projectWorkspaceSurfaces(
  scope: RuntimeMaestroWorkspaceCanvasScope,
  session: RuntimeMobileSessionTabsResult,
  revision: number,
  resolveTerminalIncarnation: (terminalHandle: string) => string | null,
  annotations: WorkspaceCanvasDocument['annotations'] = {}
): {
  surfaces: Record<string, ReturnType<typeof projectSurface>>
  unsupportedBrowserCount: number
} {
  const distinctTabs = new Map<string, WorkspaceCanvasClientTab>()
  let unsupportedBrowserCount = 0
  for (const tab of session.tabs) {
    if (tab.type === 'agent-session') {
      continue
    }
    if (tab.type === 'browser' && !tab.browserPageId) {
      unsupportedBrowserCount += 1
      continue
    }
    const tabId = tab.type === 'terminal' ? tab.parentTabId : tab.id
    const current = distinctTabs.get(tabId)
    if (!current || tab.isActive) {
      distinctTabs.set(tabId, tab)
    }
  }
  return {
    surfaces: Object.fromEntries(
      [...distinctTabs.values()].map((tab) => {
        const surface = projectSurface(
          scope,
          session,
          tab,
          revision,
          resolveTerminalIncarnation,
          annotations
        )
        return [workspaceSurfaceKey(surface.id), surface]
      })
    ),
    unsupportedBrowserCount
  }
}

export function markWorkspaceSnapshotUnavailable(
  snapshot: WorkspaceSurfaceSnapshot,
  reason: string
) {
  return WorkspaceSurfaceSnapshotSchema.parse({
    ...snapshot,
    state: 'unavailable',
    capability: { available: false, reason },
    surfaces: Object.fromEntries(
      Object.entries(snapshot.surfaces).map(([key, surface]) => [
        key,
        {
          ...surface,
          availability: 'unverifiable',
          binding:
            surface.binding.kind === 'terminal'
              ? { ...surface.binding, liveness: 'unverifiable' }
              : surface.binding
        }
      ])
    )
  })
}
