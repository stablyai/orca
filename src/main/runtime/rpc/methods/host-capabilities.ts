import { defineMethod, type RpcMethod } from '../core'
import { isPwshAvailable } from '../../../pwsh'
import { isWslAvailable, listWslDistros } from '../../../wsl'
import { isGitBashAvailable } from '../../../git-bash'

export const HOST_CAPABILITY_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'host.platform',
    params: null,
    handler: async () => ({ platform: process.platform })
  }),
  defineMethod({
    name: 'host.wsl.isAvailable',
    params: null,
    handler: async () => isWslAvailable()
  }),
  defineMethod({
    name: 'host.wsl.listDistros',
    params: null,
    handler: async () => listWslDistros()
  }),
  defineMethod({
    name: 'host.pwsh.isAvailable',
    params: null,
    handler: async () => isPwshAvailable()
  }),
  defineMethod({
    name: 'host.gitBash.isAvailable',
    params: null,
    handler: async () => isGitBashAvailable()
  })
]
