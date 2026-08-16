import type { AgentContextInspectTarget, AgentContextReport } from '../../shared/agent-context'

export type AgentContextApi = {
  inspect: (target?: AgentContextInspectTarget) => Promise<AgentContextReport>
}
