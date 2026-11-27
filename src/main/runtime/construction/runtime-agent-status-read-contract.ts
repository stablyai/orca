import type { selectFreshExplicitAgentStatus } from '../workspaces/process-listing/runtime-hook-agent-row-selection'

import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { TerminalAgent } from '../../../shared/agent-status/identity/terminal-agent'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimePtyWorktreeRecord } from '../terminal/records/runtime-terminal-state-records'

export abstract class RuntimeAgentStatusReadContract {
  protected abstract readonly ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>

  /** Rank launch authority first, then foreground evidence for agents Orca did not launch. */
  getPaneTerminalAgent(ptyId: string | null | undefined): TerminalAgent | null {
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    return pty?.launchAgent ?? pty?.foregroundAgent ?? pty?.launchCommandAgent ?? null
  }

  protected getPaneAgentForTuiIdle(ptyId: string | null | undefined): TuiAgent | null {
    const agent = this.getPaneTerminalAgent(ptyId)
    return isTuiAgent(agent) ? agent : null
  }

  protected abstract readonly getAgentStatusSnapshotForPaneFn:
    | ((paneKey: string) => AgentStatusIpcPayload[])
    | null

  protected abstract readonly publicPaneStatusFn?: (
    paneKey: string,
    terminalHandle?: string | null
  ) => AgentStatusIpcPayload[]

  abstract readonly getAgentStatusSnapshotFn: (() => AgentStatusIpcPayload[]) | null

  protected abstract getFreshExplicitAgentStatusForHandle(
    handle: string,
    ptyId: string
  ): ReturnType<typeof selectFreshExplicitAgentStatus>
}
