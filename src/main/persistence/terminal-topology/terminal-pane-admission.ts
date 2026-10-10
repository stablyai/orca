// A runtime-started pane, written through the layout module before its terminal starts (design
// 4.1): Loader, then the command, then the Serializer, so the partition is rewritten from one model.

import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { locatePane } from '../../../shared/workspace-layout/workspace-layout-command-steps'
import type {
  CommandOf,
  LayoutCommand,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import type { LoadedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { paneKeyOf } from '../../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'

/** A new tab, or a split of an existing pane, with the ids its terminal will run under. */
export type TerminalPaneAdmission =
  | (CommandOf<'createTerminalTab'> & { tabId: string; leafId: string })
  | (CommandOf<'splitPane'> & { newLeafId: string })

/** 'exists': the start attaches to a pane already in the layout, so nothing is written. */
export type TerminalPaneAdmissionOutcome = 'admitted' | 'exists' | LayoutRefusalCode

/** The partition to write, or null when nothing changes. */
export type PaneLayoutChange<T> = { value: T; session: WorkspaceSessionState | null }

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
  return applyToSession(loaded, admission, 'admitted')
}

export function withdrawPaneFromSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  pane: CommandOf<'closePane'>
): PaneLayoutChange<LayoutRefusalCode | null> {
  return applyToSession(loadWorkspaceLayout(hostId, session, nameBasedLoadContext()), pane, null)
}

function applyToSession<T>(
  loaded: LoadedWorkspaceLayout,
  command: LayoutCommand,
  committed: T
): PaneLayoutChange<T | LayoutRefusalCode> {
  const applied = applyLayoutCommand(loaded.layout, command, {
    mintId: randomUUID,
    mintLeafId: randomUUID,
    now: Date.now
  })
  return applied.ok
    ? { value: committed, session: saveWorkspaceLayout({ ...loaded, layout: applied.model }) }
    : { value: applied.code, session: null }
}
