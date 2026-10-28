import type {
  RuntimeTerminalInteractiveWait,
  RuntimeWorktreePsSummary
} from '../../shared/runtime-types'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

/** Gives each terminal-backed row on the page the same agentWait `terminal show` reports for its handle. */
export async function attachRuntimeWorktreeAgentRowWaits<
  TPage extends { worktrees: readonly RuntimeWorktreePsSummary[] }
>(
  page: TPage,
  rowSources: ReadonlyMap<string, RuntimeWorktreeAgentSource>,
  terminals: {
    getTerminalInteractiveWait(
      handle: string
    ): Promise<RuntimeTerminalInteractiveWait | null | undefined>
    getTerminalHandleForPaneKey(paneKey: string): string | null
  }
): Promise<TPage> {
  await Promise.all(
    page.worktrees.flatMap((summary) =>
      summary.agents.map(async (row) => {
        const source = rowSources.get(row.paneKey)
        // A hook handle counts only when a connected PTY confirmed it; otherwise resolve the live pane like `terminal show`.
        const handle =
          (source?.ptyId !== undefined ? source.terminalHandle : undefined) ??
          (row.hasLivePty ? terminals.getTerminalHandleForPaneKey(row.paneKey) : null)
        if (!handle) {
          return
        }
        const agentWait = await terminals.getTerminalInteractiveWait(handle)
        // Undefined means the lookup could not evaluate, so the row claims no verdict.
        if (agentWait !== undefined) {
          row.agentWait = agentWait
        }
      })
    )
  )
  return page
}
