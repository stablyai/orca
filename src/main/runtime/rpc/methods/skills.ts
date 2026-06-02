import { defineMethod, type RpcMethod } from '../core'
import { discoverSkills } from '../../../skills/discovery'

export const SKILL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'skills.discover',
    params: null,
    handler: async (_params, { runtime }) => discoverSkills({ repos: runtime.listRepos() })
  })
]
