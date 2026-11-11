import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { WorkerWorktreeCreationTarget } from './worker-worktree-creation'
import type { AgentLaunchMode } from '../../../../../../shared/agent-launch-intent'

export async function validateWorkerAgent(
  runtime: OrcaRuntimeService,
  agent: TuiAgent | undefined,
  creationTarget: WorkerWorktreeCreationTarget | undefined,
  resolvedWorktree: { id: string; repoId: string } | undefined,
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
