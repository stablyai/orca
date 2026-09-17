import type { AgentHookSource } from '../../shared/agent-hook-relay'
import type {
  AgentStatusExecutionBinding,
  AgentStatusReportedExecutionBinding
} from '../../shared/agent-status-run'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'

export type AgentStatusExecutionBindingCandidate = {
  paneKey: string
  worktreeId?: string
  source?: AgentHookSource
  emitterRole?: 'root' | 'child'
  reported: AgentStatusReportedExecutionBinding
}

export type AgentStatusExecutionBindingResolver = (
  candidate: AgentStatusExecutionBindingCandidate
) => AgentStatusExecutionBinding | null

/** Resolve only an exact emitter claim on the committed owner for this concrete surface. */
export function createAgentStatusExecutionBindingResolver(
  owners: ClaimedAgentPtyOwnerRegistry
): AgentStatusExecutionBindingResolver {
  return (candidate) => {
    return owners.findStatusBinding({
      paneKey: candidate.paneKey,
      ...(candidate.worktreeId ? { worktreeId: candidate.worktreeId } : {}),
      ...(candidate.source ? { agent: candidate.source } : {}),
      ...(candidate.emitterRole ? { role: candidate.emitterRole } : {}),
      runId: candidate.reported.runId,
      executionId: candidate.reported.executionId
    })
  }
}
