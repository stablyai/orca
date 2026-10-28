import { AgentResolveDefault } from '../../../../shared/rpc-contract/project-default-agent-params'
import { resolveProjectDefaultAgent } from '../../project-default-agent-resolution'
import { hostQualifiedRepoSelector } from '../../runtime-repo-selector'
import { defineMethod } from '../core'

export const PROJECT_DEFAULT_AGENT_METHODS = [
  defineMethod({
    name: 'agent.resolveDefault',
    permission: 'workspace',
    params: AgentResolveDefault,
    handler: async (params, { runtime }) =>
      resolveProjectDefaultAgent(
        runtime,
        params.repo
          ? {
              repo: await runtime.showRepo(
                hostQualifiedRepoSelector(params.repo, params.repoHostId)
              )
            }
          : params.worktree
            ? { worktreeId: params.worktree }
            : {},
        params.validateAgent
      )
  })
]
