import { z } from 'zod'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { OptionalString, requiredString } from '../../../schemas'
import { assertOrchestrationWorktreeCreationSupported } from '../worker/folder-worktree-placement'

const FederationAgentPreflightParams = z.object({
  worktree: requiredString('Missing remote worktree selector'),
  repo: OptionalString,
  agent: requiredString('Missing agent')
})

export async function validateFederatedAgentLauncherForRepo(
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

export const FEDERATION_AGENT_PREFLIGHT_METHOD = defineMethod({
  name: 'orchestration.federationAgentPreflight',
  params: FederationAgentPreflightParams,
  handler: async (params, { runtime }) => {
    if (!isTuiAgent(params.agent)) {
      throw new OrchestrationError('agent_unconfigured', 'A configured agent is required.')
    }
    if (params.worktree === 'current' || params.worktree === 'new-child') {
      throw new OrchestrationError(
        'invalid_argument',
        'A remote worker requires an exact existing worktree or new-top-level.'
      )
    }
    if (params.worktree === 'new-top-level') {
      if (!params.repo) {
        throw new OrchestrationError(
          'invalid_argument',
          'Remote new-top-level requires an explicit repo.'
        )
      }
      await validateFederatedAgentLauncherForRepo(runtime, params.agent, params.repo)
      return { available: true }
    }
    await resolveFederatedExistingWorktreePreflight(runtime, params.agent, params.worktree)
    return { available: true }
  }
})
