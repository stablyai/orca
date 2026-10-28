// Persist runtime pane membership before spawning through the same layout model used by client commands.

import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  leafIdsOf,
  locatePane
} from '../../../shared/workspace-layout/workspace-layout-command-steps'
import type {
  CommandOf,
  LayoutApplyOutcome,
  LayoutCommand,
  LayoutContext,
  LayoutEffects,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import type { LoadedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  paneKeyOf,
  type WorkspaceLayoutModel
} from '../../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { patchStoredSession } from '../../../shared/workspace-layout/workspace-layout-record-patch'
import {
  followRemoteSessionAfterPaneClose,
  followRemoteSessionAfterPaneDetach
} from './pane-remote-session-follow'
import { pruneClosedTerminalTabTombstones } from '../../../shared/closed-terminal-tab-tombstones'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { editorViewsOfModel, type PartitionEditorViews } from '../loading-store/layout-editor-views'

export type TerminalPaneAdmission =
  | (CommandOf<'createTerminalTab'> & { tabId: string; leafId: string })
  | (CommandOf<'splitPane'> & { newLeafId: string })

/** exists attaches without rewriting layout. */
export type TerminalPaneAdmissionOutcome = 'admitted' | 'exists' | LayoutRefusalCode

/** Null session means unchanged; views remain in memory. */
export type PaneLayoutChange<T> = {
  value: T
  session: WorkspaceSessionState | null
  views?: PartitionEditorViews
  /** Run after persistence; never expose effects in replies. */
  effects?: LayoutEffects
}

/** Runtime facts unavailable from stored layout. */
export type LayoutLiveContext = Pick<LayoutContext, 'isBindingLive' | 'retiresBinding'>

export function admitPaneToSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  admission: TerminalPaneAdmission
): PaneLayoutChange<TerminalPaneAdmissionOutcome> {
  const leafId = admission.type === 'createTerminalTab' ? admission.leafId : admission.newLeafId
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const workspace = loaded.layout.workspaces[admission.workspace]
  if (workspace && locatePane(workspace, paneKeyOf(admission.tabId, leafId))) {
    return { value: 'exists', session: null }
  }
  const change = applyToSession(loaded, admission, false, {}, touchedRecordsWrite(session, loaded))
  return { ...change, value: change.value.ok ? 'admitted' : change.value.code }
}

export function withdrawPaneFromSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  pane: CommandOf<'closePane'>
): PaneLayoutChange<LayoutRefusalCode | null> {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  const change = applyToSession(loaded, pane, false, {}, touchedRecordsWrite(session, loaded))
  return { ...change, value: change.value.ok ? null : change.value.code }
}

/** Main-owned layouts patch changed records; window-owned builds rewrite the partition. */
function touchedRecordsWrite(
  session: WorkspaceSessionState,
  loaded: LoadedWorkspaceLayout
): ((after: WorkspaceSessionState) => WorkspaceSessionState | null) | undefined {
  return ORCA_LAYOUT_OWNER_IS_MAIN ? (after) => touchedRecords(session, loaded, after) : undefined
}

function touchedRecords(
  session: WorkspaceSessionState,
  loaded: LoadedWorkspaceLayout,
  after: WorkspaceSessionState
): WorkspaceSessionState | null {
  const patched = patchStoredSession(session, saveWorkspaceLayout(loaded), after)
  return patched === session ? null : patched
}

/** Mint IDs in main and rewrite only changed records, preserving unnormalized untouched rows. */
export function applyCommandToSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  command: LayoutCommand,
  /** In-memory views absent from saved sessions. */
  views?: PartitionEditorViews,
  live: LayoutLiveContext = {}
): PaneLayoutChange<LayoutApplyOutcome> {
  const context = views
    ? { ...nameBasedLoadContext(), editorViewsOf: (key: string) => views[key] }
    : nameBasedLoadContext()
  const loaded = loadWorkspaceLayout(hostId, session, context)
  const taken = takenIds(loaded.layout, command)
  if (taken) {
    return { value: taken, session: null }
  }
  return applyToSession(loaded, command, views !== undefined, live, (after) => {
    const patched = touchedRecords(session, loaded, after)
    return patched
      ? followRemoteSessionAfterPaneDetach(
          command,
          followRemoteSessionAfterPaneClose(command, session, prunedOnRecord(command, patched))
        )
      : null
  })
}

/** Apply renames on one partition load; return each refused rename and code. */
export function applyRenamesToSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  renames: readonly CommandOf<'renameTab'>[]
): PaneLayoutChange<{ rename: CommandOf<'renameTab'>; code: LayoutRefusalCode }[]> {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  let layout = loaded.layout
  const refused: { rename: CommandOf<'renameTab'>; code: LayoutRefusalCode }[] = []
  for (const rename of renames) {
    const applied = applyLayoutCommand(layout, rename, RENAME_CONTEXT)
    if (applied.ok) {
      layout = applied.model
    } else {
      refused.push({ rename, code: applied.code })
    }
  }
  return {
    value: refused,
    session:
      layout === loaded.layout
        ? null
        : touchedRecords(session, loaded, saveWorkspaceLayout({ ...loaded, layout }))
  }
}

const RENAME_CONTEXT = { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }

/** Central admission prevents any create path from resurrecting a closed tab. */
function applyToSession(
  loaded: LoadedWorkspaceLayout,
  command: LayoutCommand,
  keepsViews: boolean,
  live: LayoutLiveContext,
  write: (after: WorkspaceSessionState) => WorkspaceSessionState | null = (after) => after
): PaneLayoutChange<LayoutApplyOutcome> {
  const closed = closedIds(loaded.layout, command)
  if (closed) {
    return { value: closed, session: null }
  }
  const applied = applyLayoutCommand(loaded.layout, command, {
    ...live,
    mintId: randomUUID,
    mintLeafId: randomUUID,
    now: Date.now,
    droppedLeafReason: 'live-edit'
  })
  return applied.ok
    ? {
        value: { ok: true, result: applied.result },
        session: write(saveWorkspaceLayout({ ...loaded, layout: applied.model })),
        effects: applied.effects,
        ...(keepsViews ? { views: editorViewsOfModel(applied.model) } : {})
      }
    : { value: { ok: false, code: applied.code }, session: null }
}

function prunedOnRecord(
  command: LayoutCommand,
  session: WorkspaceSessionState
): WorkspaceSessionState {
  return command.type === 'closeTabs' && command.recordClose
    ? {
        ...session,
        closedTerminalTabTombstonesByTabId: pruneClosedTerminalTabTombstones(
          session.closedTerminalTabTombstonesByTabId,
          Date.now()
        )
      }
    : session
}

function closedIds(
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

/** Runtime creates may target existing client tabs; only client IDs need collision checks. */
function takenIds(layout: WorkspaceLayoutModel, command: LayoutCommand): LayoutApplyOutcome | null {
  if (command.type === 'createTerminalTab') {
    return takenTabId(layout, command)
  }
  if (command.type === 'splitPane') {
    return takenLeafId(layout, command)
  }
  return command.type === 'applyDefaultTabs' ? takenDefaultTabId(layout, command) : null
}

/** Repeated client creates are no-ops on their existing pane; IDs held by another tab refuse. */
function takenTabId(
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

/** Closed tab IDs cannot be reused; pane creates may still lift closed-pane fences. */
function closedCreate(layout: WorkspaceLayoutModel, tabId: string): LayoutApplyOutcome | null {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return null
  }
  const closed = Object.values(layout.workspaces).some((entry) => entry.closedTerminalTabs?.[tabId])
  return closed ? { ok: false, code: 'tab_closed' } : null
}

/** Refuse all default tabs if any proposed ID is already taken. */
function takenDefaultTabId(
  layout: WorkspaceLayoutModel,
  command: CommandOf<'applyDefaultTabs'>
): LayoutApplyOutcome | null {
  const ids = new Set(command.tabs.map((tab) => tab.tabId))
  const holds = Object.values(layout.workspaces).some((entry) =>
    entry.tabs.some((tab) => ids.has(tab.id) || ids.has(tab.entityId))
  )
  return holds ? { ok: false, code: 'tab_exists' } : null
}

/** Repeated splits are no-ops on their existing pane; cross-tab leaf IDs refuse. */
function takenLeafId(
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
