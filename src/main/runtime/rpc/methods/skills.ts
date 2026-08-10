import { defineMethod, type RpcMethod } from '../core'
import {
  PaneSkillDiscoveryTargetSchema,
  SkillDiscoveryTargetSchema
} from '../../../../shared/skills'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../../../skills/skill-discovery-target'

export const SKILL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'skills.discover',
    params: SkillDiscoveryTargetSchema.default({}),
    handler: async (params, { runtime, signal }) => {
      // Why: the executing runtime owns WSL project preferences. Remote callers
      // send worktree identity only; trusting their projectRuntime absence
      // would scan this host's native filesystem for a WSL-configured project.
      const target = params.projectRuntime
        ? params
        : {
            ...params,
            projectRuntime: runtime.resolveProjectRuntimeForWorktree(params.worktreeId)
          }
      return discoverSkillsOnTarget(
        resolveSkillDiscoveryTarget(target),
        runtime.listRepos(),
        signal
      )
    }
  }),
  // Why: a separate method, not a field on skills.discover — old runtimes strip
  // unknown fields and would answer with a wrong-host native scan; method_not_found
  // lets clients classify the skew instead.
  defineMethod({
    name: 'skills.discoverForPane',
    params: PaneSkillDiscoveryTargetSchema,
    handler: async (params, { runtime, signal }) => runtime.discoverSkillsForPane(params, signal)
  })
]
