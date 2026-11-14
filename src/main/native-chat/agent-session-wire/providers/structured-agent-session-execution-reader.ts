import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionExecutionQualification } from '../../../../shared/agent-session/agent-session-execution-qualification'
import type { AgentSessionExecutionEvidence } from '../../../../shared/agent-session/agent-session-execution-evidence'
import type { AgentSessionUsageMeter } from '../../../../shared/agent-session/agent-session-usage-meter'

export type StructuredAgentSessionExecutionReader = {
  readUsageMeter?(input: {
    sessionId: string
    fence: number
    signal?: AbortSignal
  }): Promise<{ meter: AgentSessionUsageMeter; isCurrent: () => boolean } | null>
  readExecutionQualification?(
    record: AgentSessionRecord
  ): Promise<AgentSessionExecutionQualification['metadata'] | null>
  readExecutionEvidence?(input: {
    sessionId: string
    fence: number
    signal?: AbortSignal
  }): Promise<{ evidence: AgentSessionExecutionEvidence; isCurrent: () => boolean } | null>
}
