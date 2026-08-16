import { defineMethod, type RpcMethod } from '../core'
import { SkillDiscoveryTargetSchema } from '../../../../shared/skills'
import { inspectAgentContextOnTarget } from '../../../agent-context/agent-context-target'
import { resolveSkillDiscoveryTarget } from '../../../skills/skill-discovery-target'

export const AGENT_CONTEXT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'agentContext.inspect',
    params: SkillDiscoveryTargetSchema.default({}),
    handler: async (params, { runtime }) => {
      // Why: mirrors skills.discover — the executing runtime owns WSL project
      // preferences, so a remote caller sends worktree identity only.
      const target = params.projectRuntime
        ? params
        : {
            ...params,
            projectRuntime: runtime.resolveProjectRuntimeForWorktree(params.worktreeId)
          }
      return inspectAgentContextOnTarget(resolveSkillDiscoveryTarget(target))
    }
  })
]
