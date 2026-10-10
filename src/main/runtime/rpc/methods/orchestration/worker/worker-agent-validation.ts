import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { WorkerStartInput } from './worker-start-schema'

export async function validateWorkerAgent(
  runtime: OrcaRuntimeService,
  agent: TuiAgent | undefined,
  params: Pick<WorkerStartInput, 'repo'>,
  creationWorktree: { repoId: string } | undefined,
  resolvedWorktree: { repoId: string } | undefined
): Promise<void> {
  if (agent) {
    const repo = creationWorktree
      ? (params.repo ?? creationWorktree.repoId)
      : `id:${resolvedWorktree!.repoId}`
    await runtime.validateOrchestrationAgentLauncherForRepo(agent, repo)
  }
}
