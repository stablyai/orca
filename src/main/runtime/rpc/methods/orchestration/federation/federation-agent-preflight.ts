import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { assertOrchestrationWorktreeCreationSupported } from '../worker/folder-worktree-placement'

async function validateFederatedAgentLauncherForRepo(
  runtime: OrcaRuntimeService,
  agent: TuiAgent | undefined,
  repoSelector: string
): Promise<void> {
  if (agent) {
    await runtime.validateOrchestrationAgentLauncherForRepo(agent, repoSelector)
  }
}

export async function validateFederatedCreationPreflight(
  runtime: OrcaRuntimeService,
  agent: TuiAgent | undefined,
  repo: string | undefined,
  createsWorktree: boolean
): Promise<void> {
  if (!createsWorktree) {
    return
  }
  await assertOrchestrationWorktreeCreationSupported({
    runtime,
    repoSelector: repo as string,
    existingPlacement: 'an exact existing folder workspace'
  })
  await validateFederatedAgentLauncherForRepo(runtime, agent, repo as string)
}

export async function resolveFederatedExistingWorktreePreflight(
  runtime: OrcaRuntimeService,
  agent: TuiAgent | undefined,
  worktreeSelector: string
) {
  const worktree = await runtime.showManagedTerminalWorkspace(worktreeSelector).catch(() => {
    throw new OrchestrationError(
      'worktree_not_found_on_server',
      `Worktree ${worktreeSelector} was not found on the selected worker server.`
    )
  })
  await validateFederatedAgentLauncherForRepo(runtime, agent, `id:${worktree.repoId}`)
  return worktree
}
