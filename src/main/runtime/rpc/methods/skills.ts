import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { discoverSkills } from '../../../skills/discovery'
import { codexSkillInventory } from '../../../skills/codex-skill-inventory-service'
import { adaptCodexEffectiveSkills } from '../../../skills/codex-effective-skill-adapter'

const SkillDiscoveryParams = z.object({
  cwd: z.string().optional().nullable()
})

const CodexSkillListParams = z.object({
  cwd: z.string().min(1),
  forceReload: z.boolean().optional()
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
  }),
  defineMethod({
    name: 'skills.codexList',
    params: CodexSkillListParams,
    handler: async (params) =>
      adaptCodexEffectiveSkills(
        await codexSkillInventory.list(params.cwd, params.forceReload ?? false)
      )
  })
]
