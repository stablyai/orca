// A runtime-started pane, written through the layout module before its terminal starts (design
// 4.1): Loader, then the command, then the Serializer, so the partition is rewritten from one model.

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

/** A new tab, or a split of an existing pane, with the ids its terminal will run under. */
export type TerminalPaneAdmission =
  | (CommandOf<'createTerminalTab'> & { tabId: string; leafId: string })
  | (CommandOf<'splitPane'> & { newLeafId: string })

/** 'exists': the start attaches to a pane already in the layout, so nothing is written. */
export type TerminalPaneAdmissionOutcome = 'admitted' | 'exists' | LayoutRefusalCode

/** The partition to write, or null when nothing changes; `views`: the result's, when seeded. */
export type PaneLayoutChange<T> = {
  value: T
  session: WorkspaceSessionState | null
  views?: PartitionEditorViews
  /** What the runtime runs once the change is written; never part of a reply. */
  effects?: LayoutEffects
}

/** The runtime's live facts a command reads; the stored layout cannot know them. */
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

/** Switch point: in a layout-owner build a runtime pane writes only the records it changes, as
 *  `layout.apply` does; window-owned builds rewrite the whole partition. */
function touchedRecordsWrite(
  session: WorkspaceSessionState,
  loaded: LoadedWorkspaceLayout
): ((after: WorkspaceSessionState) => WorkspaceSessionState | null) | undefined {
  return ORCA_LAYOUT_OWNER_IS_MAIN ? (after) => touchedRecords(session, loaded, after) : undefined
}

/** The stored partition with only the records the change touched rewritten; null when none. */
function touchedRecords(
  session: WorkspaceSessionState,
  loaded: LoadedWorkspaceLayout,
  after: WorkspaceSessionState
): WorkspaceSessionState | null {
  const patched = patchStoredSession(session, saveWorkspaceLayout(loaded), after)
  return patched === session ? null : patched
}

/**
 * A client's layout command (`layout.apply`), with main minting every new id. Only the records the
 * command changed are written; the rest of the partition stays as stored, normalized or not.
 */
export function applyCommandToSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  command: LayoutCommand,
  /** Main's in-memory editor views, which the saved form lacks (layout-editor-views). */
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

/** Renames on one load of the partition, written once; each one main refused, with its code. */
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

/** Every pane write goes through here, so no create path can bring back a tab main closed. */
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
    // Every pane write here is a live edit of main's layout.
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

/** A recorded close prunes the partition's close records, as today's close does. */
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

/** A client's ids only: a runtime create may name a tab that exists, as a host's second pane does. */
function takenIds(layout: WorkspaceLayoutModel, command: LayoutCommand): LayoutApplyOutcome | null {
  if (command.type === 'createTerminalTab') {
    return takenTabId(layout, command)
  }
  if (command.type === 'splitPane') {
    return takenLeafId(layout, command)
  }
  return command.type === 'applyDefaultTabs' ? takenDefaultTabId(layout, command) : null
}

/**
 * A window's create names its own ids: the same create again (a tab main wrote first, then drew
 * from its frame) finds its pane and changes nothing; another tab in this partition holding the
 * id refuses it.
 */
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

/**
 * Switch point: a create sent again after its tab closed must not bring the tab back. Ids are
 * never reused, so a tab main recorded closed can only be such a resend. (A pane create lifts
 * the closed-pane fence by design: a window may draw a pane main took back again.)
 */
function closedCreate(layout: WorkspaceLayoutModel, tabId: string): LayoutApplyOutcome | null {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return null
  }
  const closed = Object.values(layout.workspaces).some((entry) => entry.closedTerminalTabs?.[tabId])
  return closed ? { ok: false, code: 'tab_closed' } : null
}

/** Default tabs come once, so any proposed id another tab holds refuses them all. */
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

/**
 * A window's split under its own pane id: the same split again finds its pane and changes nothing;
 * another tab holding the id refuses it.
 */
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
