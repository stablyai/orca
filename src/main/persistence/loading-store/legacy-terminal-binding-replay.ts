import { legacyPanePtySessionId } from '../../daemon/sessions/pty-session-id'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { collectRetainedTerminalLeaves } from '../../pty/legacy-terminal-topology-retirement'

type TerminalRow = WorkspaceSessionState['tabsByWorktree'][string][number]

/** One accepted replay owns its copies; incoming and prior snapshots may share records. */
export class LegacyTerminalBindingReplay {
  private readonly copiedWorkspaces = new Set<string>()
  private copiedTopology = false
  private copiedStamps = false

  constructor(
    public session: WorkspaceSessionState,
    private readonly prior: WorkspaceSessionState | undefined
  ) {}

  rebase(workspace: string, index: number, row: TerminalRow): TerminalRow {
    let layout = this.session.terminalLayoutsByTabId?.[row.id]
    const previous = this.prior?.terminalLayoutsByTabId?.[row.id]
    if (!layout?.root || !previous?.root) {
      return row
    }
    const surviving = new Set<string>()
    collectRetainedTerminalLeaves(previous, surviving)
    const current = new Set<string>()
    collectRetainedTerminalLeaves(layout, current)
    let copiedRow = false
    for (const leaf of current) {
      const id = layout.ptyIdsByLeafId?.[leaf]
      const canonical = previous.ptyIdsByLeafId?.[leaf]
      if (
        !surviving.has(leaf) ||
        !id ||
        !/^\d+$/.test(id) ||
        canonical !==
          legacyPanePtySessionId(normalizeWorkspaceSessionKeyToWorkspaceId(workspace), leaf, id)
      ) {
        continue
      }
      if (!copiedRow) {
        if (!this.copiedTopology) {
          this.session = {
            ...this.session,
            tabsByWorktree: { ...this.session.tabsByWorktree },
            terminalLayoutsByTabId: { ...this.session.terminalLayoutsByTabId }
          }
          this.copiedTopology = true
        }
        if (!this.copiedWorkspaces.has(workspace)) {
          this.session.tabsByWorktree[workspace] = [...this.session.tabsByWorktree[workspace]]
          this.copiedWorkspaces.add(workspace)
        }
        row = { ...row }
        this.session.tabsByWorktree[workspace][index] = row
        layout = { ...layout, ptyIdsByLeafId: { ...layout.ptyIdsByLeafId } }
        this.session.terminalLayoutsByTabId[row.id] = layout
        copiedRow = true
      }
      layout.ptyIdsByLeafId![leaf] = canonical
      if (row.ptyId === id) {
        row.ptyId = canonical
      }
      const pane = makePaneKey(row.id, leaf)
      const incarnation = this.prior?.terminalPtyIncarnationsByPaneKey?.[pane]
      if (this.session.terminalPtyIncarnationsByPaneKey?.[pane] === incarnation) {
        continue
      }
      if (!this.copiedStamps) {
        this.session = {
          ...this.session,
          terminalPtyIncarnationsByPaneKey: { ...this.session.terminalPtyIncarnationsByPaneKey }
        }
        this.copiedStamps = true
      }
      const stamps = this.session.terminalPtyIncarnationsByPaneKey!
      if (incarnation) {
        stamps[pane] = incarnation
      } else {
        delete stamps[pane]
      }
    }
    return row
  }
}
