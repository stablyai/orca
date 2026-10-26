import type { z } from 'zod'
import { defineMethod, InvalidArgumentError } from '../core'
import { AgentResolveDefault } from '../../../../shared/rpc-contract/agent-resolve-default-params'
import {
  resolveDefaultLaunchAgent,
  type DefaultLaunchAgentResolution
} from '../../../../shared/default-launch-agent'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'
import {
  detectAgentsOnHost,
  resolveWorkspaceAgentDetectionHost,
  type AgentDetectionHost
} from '../../../preflight/workspace-agent-detection'
import { hostQualifiedRepoSelector } from '../../runtime-repo-selector'
import type { OrcaRuntimeService } from '../../orca-runtime'

async function detectionHostFor(
  target: z.infer<typeof AgentResolveDefault>['target'],
  runtime: OrcaRuntimeService
): Promise<AgentDetectionHost> {
  if (target.kind === 'existing') {
    const workspace = await runtime.showTerminalWorkspaceLaunchScope(target.worktree)
    return runtime.resolveAgentDetectionHost(workspace.id)
  }
  // Why the repo's own host: the new worktree runs where its repo is set up, not where the CLI is.
  const repo = await runtime.showRepo(hostQualifiedRepoSelector(target.repo, target.repoHostId))
  return resolveWorkspaceAgentDetectionHost(runtime.requireStore(), {
    kind: 'worktree',
    repoId: repo.id,
    path: repo.path,
    hostId: getRepoExecutionHostId(repo)
  })
}

export const AGENT_RESOLVE_DEFAULT_METHODS = [
  defineMethod({
    name: 'agent.resolveDefault',
    permission: 'workspace',
    params: AgentResolveDefault,
    handler: async (params, { runtime }): Promise<DefaultLaunchAgentResolution> => {
      const host = await detectionHostFor(params.target, runtime)
      try {
        return await resolveDefaultLaunchAgent(runtime.getClientSettings(), () =>
          detectAgentsOnHost(host)
        )
      } catch (error) {
        // Why not `none_available`: this host cannot be probed, which is not "no agent installed".
        if (error instanceof SshHostNotServedError) {
          throw new InvalidArgumentError(
            '--agent default cannot check which agents are installed on an SSH-hosted workspace. Name an agent with --agent <id>.'
          )
        }
        throw error
      }
    }
  })
]
