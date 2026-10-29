import { SessionUnitIndex } from '../../../shared/session-unit-index'
// Local terminal counters reset on restart; unbind older stamped incarnations when a new process reuses an ID.
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { SessionUnitReader } from '../../../shared/session-unit-reader'

export type ReusedTerminalBinding = {
  ptyId: string
  incarnationId: string
  tabId: string
  leafId: string
}
type UnboundFields = Pick<
  WorkspaceSessionState,
  'terminalLayoutsByTabId' | 'terminalPtyIncarnationsByPaneKey' | 'tabsByWorktree'
>

export function reduceReusedTerminalBinding(
  reader: SessionUnitReader,
  binding: ReusedTerminalBinding
): boolean {
  let changed = false
  for (const unit of reader.references('pty', binding.ptyId)) {
    if (unit.field !== 'terminalLayoutsByTabId') {
      continue
    }
    const layout = reader.unit('terminalLayoutsByTabId', unit.key).value
    if (!layout) {
      continue
    }
    const stale = Object.entries(layout.ptyIdsByLeafId ?? {}).flatMap(([leafId, pty]) => {
      const stamp = reader.unit('terminalPtyIncarnationsByPaneKey', `${unit.key}:${leafId}`).value
      return pty === binding.ptyId &&
        !(unit.key === binding.tabId && leafId === binding.leafId) &&
        stamp !== undefined &&
        stamp !== binding.incarnationId
        ? [leafId]
        : []
    })
    if (!stale.length) {
      continue
    }
    changed = true
    const remaining = { ...layout.ptyIdsByLeafId }
    for (const leaf of stale) {
      delete remaining[leaf]
      reader.write('terminalPtyIncarnationsByPaneKey', `${unit.key}:${leaf}`, {
        present: false,
        value: undefined
      })
    }
    reader.write('terminalLayoutsByTabId', unit.key, {
      present: true,
      value: { ...layout, ptyIdsByLeafId: remaining }
    })
    for (const owner of reader.references('tab', unit.key)) {
      if (owner.field !== 'tabsByWorktree') {
        continue
      }
      const tabs = reader.unit('tabsByWorktree', owner.key).value ?? []
      if (!tabs.some((tab) => tab.id === unit.key && tab.ptyId === binding.ptyId)) {
        continue
      }
      reader.write('tabsByWorktree', owner.key, {
        present: true,
        value: tabs.map((tab) =>
          tab.id === unit.key && tab.ptyId === binding.ptyId
            ? { ...tab, ptyId: Object.values(remaining)[0] ?? null }
            : tab
        )
      })
    }
  }
  if (changed) {
    reader.reconcileField('terminalPtyIncarnationsByPaneKey', {
      kind: 'replacement',
      present: true,
      explicitEmpty: true
    })
  }
  return changed
}

/** Full ingress and keyed writes use the same pane kernel. */
export function reusedTerminalIdUnbinding(
  session: WorkspaceSessionState,
  binding: ReusedTerminalBinding
): UnboundFields | null {
  const reader = new SessionUnitReader(session, new SessionUnitIndex(session))
  if (!reduceReusedTerminalBinding(reader, binding)) {
    return null
  }
  const next = reader.snapshot()
  return {
    terminalLayoutsByTabId: next.terminalLayoutsByTabId,
    terminalPtyIncarnationsByPaneKey: next.terminalPtyIncarnationsByPaneKey,
    tabsByWorktree: next.tabsByWorktree
  }
}
