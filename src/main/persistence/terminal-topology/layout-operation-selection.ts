import type { SessionReferenceKind } from '../../../shared/session-unit-index'
import type { SessionUnitReader } from '../../../shared/session-unit-reader'
import type { SessionPatchDomain } from '../../../shared/workspace-layout/workspace-layout-record-patch'

import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'

import type { LoadedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load-types'

import type { PartitionEditorViews } from '../loading-store/layout-editor-views'

import { loadWorkspaceLayoutUnits } from '../../../shared/workspace-layout/workspace-layout-load'
import { patchSessionUnits } from '../../../shared/workspace-layout/workspace-layout-record-patch'

import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'

import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { reduceRemoteSessionAfterPaneChange } from './pane-remote-session-follow'
import { reduceClosedTerminalTabPruning } from '../closed-terminal-tab-write-fence'

export type SessionReferenceRequest = { kind: SessionReferenceKind; id: string }

export function commandSessionReferences(command: LayoutCommand): SessionReferenceRequest[] {
  const references: SessionReferenceRequest[] = [{ kind: 'owner', id: command.workspace }]
  if ('toWorkspace' in command) {
    references.push({ kind: 'owner', id: command.toWorkspace })
  }
  const add = (kind: SessionReferenceRequest['kind'], id: string | null | undefined): void => {
    if (id) {
      references.push({ kind, id })
    }
  }
  switch (command.type) {
    case 'createTerminalTab':
      add('tab', command.tabId)
      add('tab', command.afterTabId)
      add('leaf', command.leafId)
      if (command.adopt) {
        add('pty', command.adopt.ptyId)
      }
      break
    case 'splitPane':
      add('tab', command.tabId)
      add('leaf', command.leafId)
      add('leaf', command.newLeafId)
      break
    case 'movePane':
      add('tab', command.tabId)
      add('leaf', command.leafId)
      add('leaf', command.targetLeafId)
      break
    case 'closePane':
    case 'renamePane':
    case 'setPaneGrid':
    case 'setChatPane':
    case 'releasePaneTerminal':
    case 'movePaneToNewTab':
      add('tab', command.tabId)
      add('leaf', command.leafId)
      if (command.type === 'releasePaneTerminal') {
        add('pty', command.ptyId)
      }
      if (command.type === 'movePaneToNewTab') {
        add('tab', command.windowDetach?.tabId)
        add('pty', command.windowDetach?.ptyId)
      }
      break
    case 'renameTab':
    case 'setTabProps':
    case 'promotePreviewTab':
    case 'equalizePanes':
    case 'setPaneRatios':
    case 'splitGroup':
      add('tab', command.tabId)
      break
    case 'moveTab':
    case 'openSimulatorTab':
    case 'openAgentSessionTab':
      add('tab', command.tabId)
      add('tab', command.afterTabId)
      break
    case 'openEditorTab':
      add('tab', command.tabId)
      add('file', command.fileId)
      add('file', command.file?.filePath)
      break
    case 'openBrowserTab':
      add('tab', command.tabId)
      add('tab', command.afterTabId)
      add('browser', command.browserTabId)
      add('page', command.pageId)
      break
    case 'openBrowserPage':
    case 'closeBrowserPage':
    case 'replaceBrowserPage':
    case 'setBrowserTabProfile':
      add('browser', command.browserTabId)
      if (command.type !== 'setBrowserTabProfile') {
        add('page', command.pageId)
      }
      if (command.type === 'replaceBrowserPage') {
        add('page', command.newPageId)
      }
      break
    case 'startPane':
    case 'restartPane':
      add('pane', command.paneKey)
      break
    case 'sleep':
    case 'wake':
      for (const key of command.paneKeys ?? []) {
        add('pane', key)
      }
      if (command.type === 'sleep') {
        for (const record of command.records) {
          add('owner', record.worktreeId)
          add('tab', record.tabId)
          add('pane', record.paneKey)
        }
      }
      break
    case 'closeTabs':
    case 'applyDefaultTabs':
    case 'moveTabToWorkspace':
    case 'renameEditorFiles':
    case 'setDefaultTabsApplied':
    case 'setGroupRatios':
      break
  }
  if (command.type === 'closeTabs') {
    for (const id of command.tabIds) {
      references.push({ kind: 'tab', id })
    }
  }
  if (command.type === 'applyDefaultTabs') {
    for (const tab of command.tabs) {
      references.push({ kind: 'tab', id: tab.tabId }, { kind: 'leaf', id: tab.leafId })
    }
  }
  if (command.type === 'renameEditorFiles') {
    for (const also of command.alsoIn ?? []) {
      references.push({ kind: 'owner', id: also.workspace })
    }
  }
  if (command.type === 'moveTabToWorkspace') {
    for (const tab of command.tabs) {
      references.push({ kind: 'tab', id: tab.tabId }, { kind: 'tab', id: tab.newTabId })
    }
  }
  return references
}

export function loadLayoutOperation(
  hostId: ExecutionHostId,
  reader: SessionUnitReader,
  identities: readonly SessionReferenceRequest[],
  views?: PartitionEditorViews,
  full = false
) {
  const selected = reader.selectReferences(identities, full)
  const owners = reader.affectedOwners(selected)
  const orderedOwners = reader.orderSelection('tabsByWorktree', owners)
  const context = views
    ? { ...nameBasedLoadContext(), editorViewsOf: (key: string) => views[key] }
    : nameBasedLoadContext()
  return {
    loaded: loadWorkspaceLayoutUnits(hostId, reader, orderedOwners, selected, context),
    owners,
    domain: full ? { kind: 'complete' as const } : { kind: 'selected' as const, fields: selected }
  }
}

export function writeLayoutOperation(
  reader: SessionUnitReader,
  loaded: LoadedWorkspaceLayout,
  after: WorkspaceSessionState,
  domain: SessionPatchDomain,
  command?: LayoutCommand
): WorkspaceSessionState | null {
  const before = saveWorkspaceLayout(loaded)
  patchSessionUnits(reader, before, after, domain)
  if (command) {
    reduceRemoteSessionAfterPaneChange(reader, command)
  }
  if (command?.type === 'closeTabs' && command.recordClose) {
    reduceClosedTerminalTabPruning(reader, Date.now())
  }
  if (!reader.touchedFields().length) {
    return null
  }
  return reader.snapshot()
}
