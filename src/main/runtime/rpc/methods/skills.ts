import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { discoverSkills } from '../../../skills/discovery'
import { codexSkillInventory } from '../../../skills/codex-skill-inventory-service'
import { adaptCodexEffectiveSkills } from '../../../skills/codex-effective-skill-adapter'

const SkillDiscoveryParams = z.object({
  cwd: z.string().optional().nullable()
})

const CodexSkillListParams = z.object({
  cwd: z.string().min(1),
  forceReload: z.boolean().optional(),
  codexHome: z.string().optional()
})

let skillSubscriptionSequence = 0

export const SKILL_METHODS: RpcAnyMethod[] = [
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
        await codexSkillInventory.list(params.cwd, params.forceReload ?? false, params.codexHome)
      )
  }),
  defineStreamingMethod({
    name: 'skills.codexSubscribe',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      await new Promise<void>((resolve) => {
        const onChanged = (): void => emit({ type: 'changed' })
        codexSkillInventory.on('changed', onChanged)
        const id = `skills-${connectionId ?? 'inproc'}-${++skillSubscriptionSequence}`
        runtime.registerSubscriptionCleanup(
          id,
          () => {
            codexSkillInventory.off('changed', onChanged)
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
        emit({ type: 'ready' })
      })
    }
  })
]
