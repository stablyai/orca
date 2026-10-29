import { closedIds, takenIds } from './layout-command-id-conflicts'
import type { SessionPatchDomain } from '../../../shared/workspace-layout/workspace-layout-record-patch'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  LayoutApplyOutcome,
  LayoutCommand,
  LayoutEffects,
  CommandOf,
  LayoutContext,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { LoadedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load-types'

import { type PartitionEditorViews, editorViewsOfModel } from '../loading-store/layout-editor-views'
import {
  commandSessionReferences,
  loadLayoutOperation,
  writeLayoutOperation
} from './layout-operation-selection'
export {
  type SessionReferenceRequest,
  commandSessionReferences,
  loadLayoutOperation
} from './layout-operation-selection'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { SessionUnitReader } from '../../../shared/session-unit-reader'

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

// Persist runtime pane membership before spawning through the same layout model used by client commands.

import { randomUUID } from 'node:crypto'

import { locatePane } from '../../../shared/workspace-layout/workspace-layout-command-steps'

import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'

import { paneKeyOf } from '../../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'

export type TerminalPaneAdmission =
  | (CommandOf<'createTerminalTab'> & { tabId: string; leafId: string })
  | (CommandOf<'splitPane'> & { newLeafId: string })

/** exists attaches without rewriting layout. */
export type TerminalPaneAdmissionOutcome = 'admitted' | 'exists' | LayoutRefusalCode

/** Null session means unchanged; views remain in memory. */
export type PaneLayoutChange<T> = {
  value: T
  session: WorkspaceSessionState | null
  prepared?: SessionUnitReader
  views?: PartitionEditorViews
  changedOwners?: ReadonlySet<string>
  /** Run after persistence; never expose effects in replies. */
  effects?: LayoutEffects
}

/** Runtime facts unavailable from stored layout. */
export type LayoutLiveContext = Pick<LayoutContext, 'isBindingLive' | 'retiresBinding'>

const RENAME_CONTEXT = { mintId: randomUUID, mintLeafId: randomUUID, now: Date.now }

/** Central admission prevents any create path from resurrecting a closed tab. */
function applyToSession(
  reader: SessionUnitReader,
  loaded: LoadedWorkspaceLayout,
  command: LayoutCommand,
  keepsViews: boolean,
  live: LayoutLiveContext,
  domain: SessionPatchDomain,
  incremental: boolean,
  admission = false
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
  if (!applied.ok) {
    return { value: { ok: false, code: applied.code }, session: null }
  }
  const after = saveWorkspaceLayout({ ...loaded, layout: applied.model })
  // Window-owned admission retains its existing full-save boundary.
  if (!incremental && !ORCA_LAYOUT_OWNER_IS_MAIN && admission) {
    return { value: { ok: true, result: applied.result }, session: after, effects: applied.effects }
  }
  const session = writeLayoutOperation(reader, loaded, after, domain, command)
  return {
    value: { ok: true, result: applied.result },
    session,
    effects: applied.effects,
    ...(incremental && session ? { prepared: reader } : {}),
    ...(keepsViews ? { views: editorViewsOfModel(applied.model) } : {})
  }
}

/** Runtime creates may target existing client tabs; only client IDs need collision checks. */

/** Repeated client creates are no-ops on their existing pane; IDs held by another tab refuse. */

/** Closed tab IDs cannot be reused; pane creates may still lift closed-pane fences. */

/** Refuse all default tabs if any proposed ID is already taken. */

/** Repeated splits are no-ops on their existing pane; cross-tab leaf IDs refuse. */

export function admitPaneToSession(
  hostId: ExecutionHostId,
  source: WorkspaceSessionState | SessionUnitReader,
  admission: TerminalPaneAdmission
): PaneLayoutChange<TerminalPaneAdmissionOutcome> {
  const incremental = source instanceof SessionUnitReader
  const reader = incremental ? source : new SessionUnitReader(source, new SessionUnitIndex(source))
  const { loaded, owners, domain } = loadLayoutOperation(
    hostId,
    reader,
    commandSessionReferences(admission),
    undefined,
    !incremental
  )
  const leaf = admission.type === 'createTerminalTab' ? admission.leafId : admission.newLeafId
  if (
    loaded.layout.workspaces[admission.workspace] &&
    locatePane(loaded.layout.workspaces[admission.workspace], paneKeyOf(admission.tabId, leaf))
  ) {
    return { value: 'exists', session: null }
  }
  const change = applyToSession(reader, loaded, admission, false, {}, domain, incremental, true)
  return {
    ...change,
    value: change.value.ok ? 'admitted' : change.value.code,
    ...(incremental ? { changedOwners: owners } : {})
  }
}

export function withdrawPaneFromSession(
  hostId: ExecutionHostId,
  source: WorkspaceSessionState | SessionUnitReader,
  command: CommandOf<'closePane'>
): PaneLayoutChange<LayoutRefusalCode | null> {
  const incremental = source instanceof SessionUnitReader
  const reader = incremental ? source : new SessionUnitReader(source, new SessionUnitIndex(source))
  const { loaded, owners, domain } = loadLayoutOperation(
    hostId,
    reader,
    commandSessionReferences(command),
    undefined,
    !incremental
  )
  const change = applyToSession(reader, loaded, command, false, {}, domain, incremental, true)
  return {
    ...change,
    value: change.value.ok ? null : change.value.code,
    ...(incremental ? { changedOwners: owners } : {})
  }
}

export function applyCommandToSession(
  hostId: ExecutionHostId,
  source: WorkspaceSessionState | SessionUnitReader,
  command: LayoutCommand,
  views?: PartitionEditorViews,
  live: LayoutLiveContext = {}
): PaneLayoutChange<LayoutApplyOutcome> {
  const incremental = source instanceof SessionUnitReader
  const reader = incremental ? source : new SessionUnitReader(source, new SessionUnitIndex(source))
  const { loaded, owners, domain } = loadLayoutOperation(
    hostId,
    reader,
    commandSessionReferences(command),
    views,
    !incremental
  )
  const taken = takenIds(loaded.layout, command)
  if (taken) {
    return { value: taken, session: null, ...(incremental ? { changedOwners: owners } : {}) }
  }
  return {
    ...applyToSession(reader, loaded, command, views !== undefined, live, domain, incremental),
    ...(incremental ? { changedOwners: owners } : {})
  }
}

export function applyRenamesToSession(
  hostId: ExecutionHostId,
  source: WorkspaceSessionState | SessionUnitReader,
  renames: readonly CommandOf<'renameTab'>[]
): PaneLayoutChange<{ rename: CommandOf<'renameTab'>; code: LayoutRefusalCode }[]> {
  const incremental = source instanceof SessionUnitReader
  const reader = incremental ? source : new SessionUnitReader(source, new SessionUnitIndex(source))
  const { loaded, owners, domain } = loadLayoutOperation(
    hostId,
    reader,
    renames.flatMap(commandSessionReferences),
    undefined,
    !incremental
  )
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
    ...(incremental && layout !== loaded.layout ? { prepared: reader } : {}),
    session:
      layout === loaded.layout
        ? null
        : writeLayoutOperation(reader, loaded, saveWorkspaceLayout({ ...loaded, layout }), domain),
    ...(incremental ? { changedOwners: owners } : {})
  }
}
