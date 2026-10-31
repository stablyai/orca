import {
  sourceTabPresentation,
  workspaceEntityKey,
  workspaceSourceOwnsTab
} from '../../../shared/workspace-presentation'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  LayoutCommand,
  LayoutApplyOutcome
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { reduceWorkspacePresentation } from '../../../shared/workspace-presentation-intent'
import { composeWorkspacePresentation } from '../../../shared/workspace-presentation-reconcile'
import {
  storedWorkspacePresentationFor,
  writeWorkspacePresentation,
  type PresentationState
} from './workspace-presentation-publication'
import { applyCommandToSession } from '../terminal-topology/terminal-pane-admission'

/** Resolve a displayed member to its genuine raw occurrence before runtime host lookup. */
export function storedWorkspaceSourceAddress(
  state: PresentationState,
  workspace: string,
  tabId: string
) {
  const saved = storedWorkspacePresentationFor(state, workspace)?.document
  const placed = saved?.tabs.find((tab) => tab.id === tabId || tab.entity.entityId === tabId)
  if (!saved) {
    return undefined
  }
  for (const { source } of saved.baseline) {
    const session =
      source.hostId === 'local'
        ? state.workspaceSession
        : state.workspaceSessionsByHostId?.[source.hostId]
    const tab = session?.unifiedTabs?.[source.workspaceId]?.find(
      (tab) =>
        workspaceSourceOwnsTab(tab, source) &&
        (tab.id === tabId || tab.entityId === tabId) &&
        (!placed ||
          workspaceEntityKey(sourceTabPresentation(tab, source).entity) ===
            workspaceEntityKey(placed.entity))
    )
    if (tab) {
      return { workspace: source.workspaceId, tabId: tab.id, hostId: source.hostId }
    }
  }
  return undefined
}

/** Source topology is addressed separately from the user's outer placement, in one owner mutation. */
export function preparePresentationSourceCommand(
  state: PresentationState,
  command: LayoutCommand,
  hostId: ExecutionHostId
) {
  const found = storedWorkspacePresentationFor(state, command.workspace)
  if (!found) {
    return { command, settle: (_outcome: LayoutApplyOutcome) => {} }
  }
  const saved = found.document
  const sources = saved.baseline.map((baseline) => {
    const session =
      baseline.source.hostId === 'local'
        ? state.workspaceSession
        : state.workspaceSessionsByHostId?.[baseline.source.hostId]
    return { baseline, session, tabs: session?.unifiedTabs?.[baseline.source.workspaceId] ?? [] }
  })
  const tabId =
    'tabId' in command
      ? command.tabId
      : command.type === 'closeTabs'
        ? command.tabIds[0]
        : command.type === 'moveTabToWorkspace'
          ? command.tabs[0]?.tabId
          : 'browserTabId' in command
            ? command.browserTabId
            : undefined
  const own = tabId
    ? sources.find(
        ({ baseline, tabs }) =>
          baseline.source.hostId === hostId &&
          tabs.some((tab) => tab.id === tabId || tab.entityId === tabId)
      )
    : undefined
  const sourceId = own?.baseline.source.workspaceId ?? command.workspace
  const session =
    hostId === 'local' ? state.workspaceSession : state.workspaceSessionsByHostId?.[hostId]
  const groups = session?.tabGroups?.[sourceId] ?? []
  let addressed: LayoutCommand = { ...command, workspace: sourceId }
  if ('groupId' in addressed && addressed.type !== 'moveTabToWorkspace') {
    const requested = addressed.groupId
    const groupId =
      groups.find((group) => group.id === requested)?.id ??
      groups.find((group) => group.id === session?.activeGroupIdByWorktree?.[sourceId])?.id ??
      groups[0]?.id
    addressed = { ...addressed, groupId }
  }
  if ('afterTabId' in addressed) {
    const afterTabId = addressed.afterTabId
    if (afterTabId && !session?.unifiedTabs?.[sourceId]?.some((tab) => tab.id === afterTabId)) {
      addressed = { ...addressed, afterTabId: undefined }
    }
  }
  if ('split' in addressed) {
    addressed = { ...addressed, split: undefined }
  }
  const view = composeWorkspacePresentation(saved, sources)
  const workspace = saved.displayWorkspaceId
  const transient: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: { [workspace]: view.tabs },
    tabGroups: { [workspace]: view.groups },
    tabGroupLayouts: view.layout ? { [workspace]: view.layout } : {},
    activeGroupIdByWorktree: view.activeGroupId ? { [workspace]: view.activeGroupId } : {},
    tabsByWorktree: {
      [workspace]: sources.flatMap(
        ({ baseline, session }) => session?.tabsByWorktree[baseline.source.workspaceId] ?? []
      )
    },
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
    terminalLayoutsByTabId: Object.fromEntries(
      sources.flatMap(({ session }) => Object.entries(session?.terminalLayoutsByTabId ?? {}))
    )
  }
  return {
    command: addressed,
    settle: (outcome: LayoutApplyOutcome) => {
      if (!outcome.ok || saved.owner !== 'main') {
        return
      }
      let actual: LayoutCommand = command
      if (outcome.result.tabId) {
        switch (command.type) {
          case 'createTerminalTab':
            actual = {
              ...command,
              tabId: outcome.result.tabId,
              leafId: outcome.result.leafId ?? command.leafId
            }
            break
          case 'openEditorTab':
          case 'openBrowserTab':
          case 'openAgentSessionTab':
          case 'openSimulatorTab':
            actual = { ...command, tabId: outcome.result.tabId }
            break
          case 'movePaneToNewTab':
            actual = {
              ...command,
              windowDetach: {
                ...command.windowDetach,
                ptyId: command.windowDetach?.ptyId ?? null,
                tabId: outcome.result.tabId
              }
            }
            break
        }
      }
      const change = applyCommandToSession(hostId, transient, { ...actual, workspace })
      if (!change.value.ok || !change.session) {
        return
      }
      const after = change.session
      const created =
        outcome.result.tabId && !view.tabs.some((tab) => tab.id === outcome.result.tabId)
          ? after.unifiedTabs?.[workspace]?.find((tab) => tab.id === outcome.result.tabId)
          : undefined
      writeWorkspacePresentation(
        state,
        found.key,
        reduceWorkspacePresentation(saved, {
          type: 'layout',
          tabs: after.unifiedTabs?.[workspace] ?? [],
          groups: (after.tabGroups?.[workspace] ?? []).map((group) =>
            created?.groupId === group.id ? { ...group, activeTabId: created.id } : group
          ),
          layout: after.tabGroupLayouts?.[workspace],
          activeGroupId: created?.groupId ?? after.activeGroupIdByWorktree?.[workspace]
        })
      )
    }
  }
}
