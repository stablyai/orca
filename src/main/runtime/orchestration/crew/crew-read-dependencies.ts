import type { DispatchCreator } from '../db/dispatch-depth'
import type { TerminalIdentityReadContext } from '../../terminal/query/terminal-identity-read-context'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration-fleet-agent-status-evidence'
import type { OrchestrationDb } from '../db'
import type { AgentSessionRecordReader } from '../structured-session-lineage'

export type CrewReadDependencies = {
  db: OrchestrationDb | null
  retainedDbExists: boolean
  hostKey: string
  records: AgentSessionRecordReader | null
  liveHandle: (handle: string) => boolean
  handleForPane: (pane: string) => string | null
  paneForHandle: (handle: string) => string | null
  name: (
    party: AgentMessageSender['party'],
    taskName: string | null,
    records: AgentSessionRecordReader | null
  ) => string | null
  callerPaneForHandle?: (handle: string) => string | null
  livePaneForHandle?: (handle: string) => string | null
  processForHandle?: (handle: string) => string | null
  callerProjection?: (handle: string) => DispatchCreator
  maxDepth?: () => number
  statuses: readonly FleetAgentStatusEvidence[]
  now?: number
  openIdentityRead?: () => CrewIdentityRead
  openRuntimeIdentityRead?: () => TerminalIdentityReadContext
}

export type CrewIdentityRead = Pick<
  CrewReadDependencies,
  | 'callerProjection'
  | 'liveHandle'
  | 'handleForPane'
  | 'paneForHandle'
  | 'processForHandle'
  | 'callerPaneForHandle'
  | 'livePaneForHandle'
  | 'name'
>
