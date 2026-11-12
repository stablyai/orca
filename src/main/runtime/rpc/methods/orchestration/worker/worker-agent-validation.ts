import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchMode } from '../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import type { WorkerWorktreeCreationTarget } from './worker-worktree-creation'

export async function validateWorkerAgent(
  runtime: OrcaRuntimeService,
  agent: TuiAgent | undefined,
  creationTarget: WorkerWorktreeCreationTarget | undefined,
  resolvedWorktree: { id: string } | undefined,
  mode: AgentLaunchMode
): Promise<void> {
  if (agent) {
    await (creationTarget
      ? runtime.validateOrchestrationAgentLauncherForRepo(agent, creationTarget.repoSelector, mode)
      : runtime.validateOrchestrationAgentLauncherForWorktree(
          agent,
          `id:${resolvedWorktree!.id}`,
          mode
        ))
  }
}
