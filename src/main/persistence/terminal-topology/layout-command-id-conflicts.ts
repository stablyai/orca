import type {
  LayoutApplyOutcome,
  LayoutCommand,
  CommandOf
} from '../../../shared/workspace-layout/workspace-layout-command-types'

import {
  type WorkspaceLayoutModel,
  paneKeyOf
} from '../../../shared/workspace-layout/workspace-layout-model'

import {
  leafIdsOf,
  locatePane
} from '../../../shared/workspace-layout/workspace-layout-command-steps'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'

export function closedIds(
  layout: WorkspaceLayoutModel,
  command: LayoutCommand
): LayoutApplyOutcome | null {
  if (command.type === 'createTerminalTab') {
    return command.tabId ? closedCreate(layout, command.tabId) : null
  }
  if (command.type === 'applyDefaultTabs') {
    for (const tab of command.tabs) {
      const closed = closedCreate(layout, tab.tabId)
      if (closed) {
        return closed
      }
    }
  }
  return null
}

export function takenIds(
  layout: WorkspaceLayoutModel,
  command: LayoutCommand
): LayoutApplyOutcome | null {
  if (command.type === 'createTerminalTab') {
    return takenTabId(layout, command)
  }
  if (command.type === 'splitPane') {
    return takenLeafId(layout, command)
  }
  return command.type === 'applyDefaultTabs' ? takenDefaultTabId(layout, command) : null
}

export function takenTabId(
  layout: WorkspaceLayoutModel,
  command: CommandOf<'createTerminalTab'>
): LayoutApplyOutcome | null {
  const { workspace: key, tabId, leafId } = command
  if (!tabId) {
    return null
  }
  const workspace = layout.workspaces[key]
  const paneKey = leafId ? paneKeyOf(tabId, leafId) : null
  if (workspace && paneKey && locatePane(workspace, paneKey)) {
    return { ok: true, result: { tabId, leafId, paneKey } }
  }
  const holds = Object.values(layout.workspaces).some((entry) =>
    entry.tabs.some((tab) => tab.id === tabId || tab.entityId === tabId)
  )
  return holds ? { ok: false, code: 'tab_exists' } : null
}

export function closedCreate(
  layout: WorkspaceLayoutModel,
  tabId: string
): LayoutApplyOutcome | null {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return null
  }
  const closed = Object.values(layout.workspaces).some((entry) => entry.closedTerminalTabs?.[tabId])
  return closed ? { ok: false, code: 'tab_closed' } : null
}

export function takenDefaultTabId(
  layout: WorkspaceLayoutModel,
  command: CommandOf<'applyDefaultTabs'>
): LayoutApplyOutcome | null {
  const ids = new Set(command.tabs.map((tab) => tab.tabId))
  const holds = Object.values(layout.workspaces).some((entry) =>
    entry.tabs.some((tab) => ids.has(tab.id) || ids.has(tab.entityId))
  )
  return holds ? { ok: false, code: 'tab_exists' } : null
}

export function takenLeafId(
  layout: WorkspaceLayoutModel,
  command: CommandOf<'splitPane'>
): LayoutApplyOutcome | null {
  const { workspace: key, tabId, newLeafId } = command
  const workspace = layout.workspaces[key]
  if (!newLeafId || !workspace) {
    return null
  }
  const paneKey = paneKeyOf(tabId, newLeafId)
  if (locatePane(workspace, paneKey)) {
    return { ok: true, result: { leafId: newLeafId, paneKey } }
  }
  const held = workspace.tabs.some(
    (tab) => tab.kind === 'terminal' && leafIdsOf(tab).includes(newLeafId)
  )
  return held ? { ok: false, code: 'pane_in_other_tab' } : null
}
