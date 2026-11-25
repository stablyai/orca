import type { selectFreshExplicitAgentStatus } from '../workspaces/process-listing/runtime-hook-agent-row-selection'

import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'

export abstract class RuntimeAgentStatusReadContract {
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
