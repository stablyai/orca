import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  tabPresentation,
  type WorkspacePresentation,
  type WorkspacePresentationKey
} from '../../../shared/workspace-presentation'
import { composeWorkspacePresentation } from '../../../shared/workspace-presentation-reconcile'
import type {
  LayoutCommand,
  LayoutApplyOutcome
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation, StoreRuntimeState } from './store-runtime-state'
import { scheduleSave, type WriteSchedulingOperations } from './write-scheduling'
import {
  storedWorkspacePresentationFor,
  writeWorkspacePresentation
} from './workspace-presentation-publication'
import { applyCommandToSession } from '../terminal-topology/terminal-pane-admission'

/** Main reduces client group intents against a transient view, never a projected membership codec. */
export function applyWorkspacePresentationCommand(
  runtime: Pick<StoreRuntimeState, 'state' | 'runDurableMutation'>,
  scheduling: WriteSchedulingOperations,
  command: LayoutCommand
): Promise<LayoutApplyOutcome> | undefined {
  if (
    !ORCA_LAYOUT_OWNER_IS_MAIN ||
    !['moveTab', 'splitGroup', 'setGroupRatios'].includes(command.type)
  ) {
    return undefined
  }
  const found = storedWorkspacePresentationFor(runtime.state, command.workspace)
  if (!found || found.document.owner !== 'main') {
    return undefined
  }
  const key: WorkspacePresentationKey = found.key
  return runtime.runDurableMutation((): DurableProfileStateMutation<LayoutApplyOutcome> => {
    const saved = runtime.state[key]
    if (!saved) {
      return { value: { ok: false, code: 'workspace_not_found' }, persist: false }
    }
    const sources = saved.baseline.map((baseline) => {
      const session =
        baseline.source.hostId === 'local'
          ? runtime.state.workspaceSession
          : runtime.state.workspaceSessionsByHostId?.[baseline.source.hostId]
      return { baseline, session, tabs: session?.unifiedTabs?.[baseline.source.workspaceId] ?? [] }
    })
    const view = composeWorkspacePresentation(saved, sources)
    const workspace = saved.displayWorkspaceId
    const transient = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [workspace]: sources.flatMap(
          ({ baseline, session }) => session?.tabsByWorktree[baseline.source.workspaceId] ?? []
        )
      },
      terminalLayoutsByTabId: Object.fromEntries(
        sources.flatMap(({ session, tabs }) =>
          tabs.flatMap((tab) => {
            const layout = session?.terminalLayoutsByTabId?.[tab.entityId]
            return layout ? [[tab.entityId, layout]] : []
          })
        )
      ),
      openFilesByWorktree: {
        [workspace]: sources.flatMap(
          ({ baseline, session }) =>
            session?.openFilesByWorktree?.[baseline.source.workspaceId] ?? []
        )
      },
      browserTabsByWorktree: {
        [workspace]: sources.flatMap(
          ({ baseline, session }) =>
            session?.browserTabsByWorktree?.[baseline.source.workspaceId] ?? []
        )
      },
      unifiedTabs: { [workspace]: view.tabs },
      tabGroups: { [workspace]: view.groups },
      tabGroupLayouts: view.layout ? { [workspace]: view.layout } : {},
      activeGroupIdByWorktree: view.activeGroupId ? { [workspace]: view.activeGroupId } : {}
    }
    const change = applyCommandToSession('local', transient, { ...command, workspace })
    if (!change.value.ok || !change.session) {
      return { value: change.value, persist: false }
    }
    const after = change.session
    const entities = new Map(saved.tabs.map((tab) => [tab.id, tab.entity]))
    const edited: WorkspacePresentation = {
      ...saved,
      tabs: (after.unifiedTabs?.[workspace] ?? []).map((tab) => ({
        ...tabPresentation(tab, saved.anchor.executionHostId ?? saved.anchor.hostId),
        entity:
          entities.get(tab.id) ??
          tabPresentation(tab, saved.anchor.executionHostId ?? saved.anchor.hostId).entity
      })),
      groups: after.tabGroups?.[workspace] ?? [],
      layout: after.tabGroupLayouts?.[workspace],
      activeGroupId: after.activeGroupIdByWorktree?.[workspace]
    }
    writeWorkspacePresentation(runtime.state, key, edited)
    scheduleSave(scheduling, [key])
    return { value: change.value }
  })
}
