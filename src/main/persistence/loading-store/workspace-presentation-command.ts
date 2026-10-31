import {
  isPresentationOnlyCommand,
  reduceWorkspacePresentation
} from '../../../shared/workspace-presentation-intent'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspacePresentationKey } from '../../../shared/workspace-presentation'
import { composeWorkspacePresentation } from '../../../shared/workspace-presentation-reconcile'
import type {
  LayoutCommand,
  LayoutApplyOutcome
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation, StoreRuntimeState } from './store-runtime-state'
import { scheduleSave, type WriteSchedulingOperations } from './write-scheduling'
import {
  storedWorkspacePresentationFor,
  writeWorkspacePresentation,
  type PresentationState
} from './workspace-presentation-publication'
import { applyCommandToSession } from '../terminal-topology/terminal-pane-admission'

/** Main reduces client group intents against a transient view, never a projected membership codec. */
export function applyWorkspacePresentationCommand(
  runtime: Pick<StoreRuntimeState, 'state' | 'runDurableMutation'>,
  scheduling: WriteSchedulingOperations,
  command: LayoutCommand
): Promise<LayoutApplyOutcome> | undefined {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || !isPresentationOnlyCommand(command)) {
    return undefined
  }
  const found = storedWorkspacePresentationFor(runtime.state, command.workspace)
  if (!found || found.document.owner !== 'main') {
    return undefined
  }
  const key: WorkspacePresentationKey = found.key
  return runtime.runDurableMutation((): DurableProfileStateMutation<LayoutApplyOutcome> => {
    const value = reduceStoredPresentationCommand(runtime.state, command)!
    scheduleSave(scheduling, [key])
    return { value }
  })
}

/** Runs inside the existing source/U transaction, including multi-tab custom label edits. */
export function reduceStoredPresentationCommand(
  state: PresentationState,
  command: LayoutCommand
): LayoutApplyOutcome | undefined {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || !isPresentationOnlyCommand(command)) {
    return undefined
  }
  const found = storedWorkspacePresentationFor(state, command.workspace)
  if (!found || found.document.owner !== 'main') {
    return undefined
  }
  const key = found.key
  const saved = state[key]
  if (!saved) {
    return { ok: false, code: 'workspace_not_found' }
  }
  const sources = saved.baseline.map((baseline) => {
    const session =
      baseline.source.hostId === 'local'
        ? state.workspaceSession
        : state.workspaceSessionsByHostId?.[baseline.source.hostId]
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
        ({ baseline, session }) => session?.openFilesByWorktree?.[baseline.source.workspaceId] ?? []
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
    return change.value
  }
  const after = change.session
  const edited = reduceWorkspacePresentation(saved, {
    type: 'layout',
    tabs: after.unifiedTabs?.[workspace] ?? [],
    groups: after.tabGroups?.[workspace] ?? [],
    layout: after.tabGroupLayouts?.[workspace],
    activeGroupId: after.activeGroupIdByWorktree?.[workspace]
  })
  writeWorkspacePresentation(state, key, edited)
  return change.value
}
