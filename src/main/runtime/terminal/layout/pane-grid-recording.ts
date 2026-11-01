// Persist pane grids once per resize burst so main restarts terminals at their last size.

import type { TerminalGrid } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { WindowLayoutCommand } from '../../runtime-layout-apply'

export const PANE_GRID_RECORD_DELAY_MS = 1_000
/** A quit's grid writes never hold the stop longer than this; a grid missed restarts at the default size. */
export const PANE_GRID_FLUSH_BUDGET_MS = 1_000

type ShownPane = { workspace: string; tabId: string; leafId: string }

/** The pane `session` binds to the terminal, or null. */
export function paneShowingTerminal(
  session: WorkspaceSessionState,
  ptyId: string
): ShownPane | null {
  for (const [workspace, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const row of rows) {
      const bindings = session.terminalLayoutsByTabId?.[row.id]?.ptyIdsByLeafId ?? {}
      const leafId = Object.keys(bindings).find((leaf) => bindings[leaf] === ptyId)
      if (leafId) {
        return { workspace, tabId: row.id, leafId }
      }
    }
  }
  return null
}

export type PaneGridRecordingPorts = {
  sessions: () => Iterable<WorkspaceSessionState>
  apply: (command: WindowLayoutCommand) => Promise<unknown>
}

export class PaneGridRecorder {
  private readonly pending = new Map<string, { grid: TerminalGrid; timer: NodeJS.Timeout }>()

  constructor(
    private readonly ports: PaneGridRecordingPorts,
    private readonly delayMs = PANE_GRID_RECORD_DELAY_MS
  ) {}

  record(ptyId: string, grid: TerminalGrid): void {
    if (grid.cols <= 0 || grid.rows <= 0) {
      return
    }
    clearTimeout(this.pending.get(ptyId)?.timer)
    const timer = setTimeout(() => void this.write(ptyId), this.delayMs)
    timer.unref?.()
    this.pending.set(ptyId, { grid, timer })
  }

  /** Writes every grid still waiting, for a quit's final save, within the budget; null when none waits. */
  flush(budgetMs = PANE_GRID_FLUSH_BUDGET_MS): Promise<void> | null {
    if (this.pending.size === 0) {
      return null
    }
    let timer: NodeJS.Timeout | undefined
    // A grid that cannot be written must never cost the quit its final save.
    const writes = Promise.all([...this.pending.keys()].map((ptyId) => this.write(ptyId))).then(
      () => {},
      () => {}
    )
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs)
    })
    return Promise.race([writes, budget]).finally(() => clearTimeout(timer))
  }

  private async write(ptyId: string): Promise<void> {
    const entry = this.pending.get(ptyId)
    if (!entry) {
      return
    }
    clearTimeout(entry.timer)
    this.pending.delete(ptyId)
    for (const session of this.ports.sessions()) {
      const pane = paneShowingTerminal(session, ptyId)
      if (pane) {
        // A refusal means the pane went away meanwhile: nothing to remember.
        await this.ports.apply({ type: 'setPaneGrid', ...pane, grid: entry.grid }).catch(() => {})
        return
      }
    }
  }
}
