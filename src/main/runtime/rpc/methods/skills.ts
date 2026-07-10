import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { discoverSkills } from '../../../skills/discovery'

const SkillDiscoveryParams = z.object({
  cwd: z.string().optional().nullable()
})

export const SKILL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'skills.discover',
    params: SkillDiscoveryParams,
    handler: async (params, { runtime }) => {
      const cwd = params.cwd?.trim() || undefined
      return cwd
        ? discoverSkills({ repos: [], cwd })
        : discoverSkills({ repos: runtime.listRepos() })
    }
  })
]
