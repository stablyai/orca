import { SessionUnitIndex } from '../../shared/session-unit-index'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { SessionUnitReader } from '../../shared/session-unit-reader'

/** Renderer omissions preserve host fields; explicit containers retain their existing meaning. */
export function reduceRuntimeAuthoredSessionFields(
  reader: SessionUnitReader,
  owners: Iterable<string>,
  panes: Iterable<string>
): void {
  reader.admitFields()
  for (const owner of owners) {
    const prior = reader.unit('defaultTerminalTabsAppliedByWorktreeId', owner, 'prior')
    if (prior.present && !reader.unit('defaultTerminalTabsAppliedByWorktreeId', owner).present) {
      reader.write('defaultTerminalTabsAppliedByWorktreeId', owner, prior)
    }
  }
  for (const pane of panes) {
    const parsed = parsePaneKey(pane)
    if (!parsed || reader.unit('terminalPtyIncarnationsByPaneKey', pane).present) {
      continue
    }
    const incarnation = reader.unit('terminalPtyIncarnationsByPaneKey', pane, 'prior')
    if (!incarnation.present) {
      continue
    }
    const prior = reader.unit('terminalLayoutsByTabId', parsed.tabId, 'prior').value
      ?.ptyIdsByLeafId?.[parsed.leafId]
    const candidate = reader.unit('terminalLayoutsByTabId', parsed.tabId).value?.ptyIdsByLeafId?.[
      parsed.leafId
    ]
    if (prior !== undefined && prior === candidate) {
      reader.write('terminalPtyIncarnationsByPaneKey', pane, incarnation)
    }
  }
}

export function preserveRuntimeAuthoredWorkspaceSessionFields(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  if (!prior) {
    return next
  }
  const reader = SessionUnitReader.between(prior, next, new SessionUnitIndex(prior))
  reduceRuntimeAuthoredSessionFields(
    reader,
    Object.keys(prior.defaultTerminalTabsAppliedByWorktreeId ?? {}),
    Object.keys(prior.terminalPtyIncarnationsByPaneKey ?? {})
  )
  return reader.snapshot()
}
