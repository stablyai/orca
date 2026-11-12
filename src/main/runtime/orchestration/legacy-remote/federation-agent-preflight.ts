import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../orchestration-error'
import { assertOrchestrationWorktreeCreationSupported } from '../../rpc/methods/orchestration/worker/folder-worktree-placement'

export async function validateFederatedCreationPreflight(
  runtime: OrcaRuntimeService,
  agent: TuiAgent | undefined,
  repo: string | undefined
): Promise<void> {
  if (!repo) {
    throw new OrchestrationError(
      'invalid_argument',
      'A remote new-top-level worktree requires an explicit --repo.'
    )
  }
  await assertOrchestrationWorktreeCreationSupported({
    runtime,
    repoSelector: repo,
    existingPlacement: 'an exact existing folder workspace'
  })
  if (agent) {
    await runtime.validateOrchestrationAgentLauncherForRepo(agent, repo, 'terminal')
  }
}

export async function resolveFederatedExistingWorktreePreflight(
  runtime: OrcaRuntimeService,
  agent: TuiAgent | undefined,
  worktreeSelector: string
) {
  const worktree = await runtime
    .showTerminalWorkspaceLaunchScope(worktreeSelector)
    .catch((error) => {
      if (!hasRuntimeRpcErrorCode(error, 'selector_not_found')) {
        throw error
      }
      throw new OrchestrationError(
        'worktree_not_found_on_server',
        `Worktree ${worktreeSelector} was not found on the selected worker server.`
      )
    })
  if (agent) {
    await runtime.validateOrchestrationAgentLauncherForWorktree(agent, worktreeSelector, 'terminal')
  }
  return worktree
}
