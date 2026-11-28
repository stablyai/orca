import os from 'node:os'
import { HOST_RESOURCES_METHOD } from '../../../../shared/host-resources'
import { collectHostResources } from '../../../memory/host-resources'
import { defineMethod } from '../core'

export const HOST_RESOURCES_METHODS = [
  defineMethod({
    name: HOST_RESOURCES_METHOD,
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => {
      const volumePaths = [
        { role: 'home' as const, path: os.homedir() },
        ...runtime.listRepos().map((repo) => ({ role: 'workspace' as const, path: repo.path }))
      ]
      return collectHostResources(volumePaths)
    }
  })
]
