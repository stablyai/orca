import { defineMethod } from '../core'
import { isPwshAvailableAsync } from '../../../pwsh'
import { isWslAvailableAsync, listWslDistrosAsync } from '../../../wsl'
import { isGitBashAvailable } from '../../../git-bash'

export const HOST_CAPABILITY_METHODS = [
  defineMethod({
    name: 'host.platform',
    permission: 'workspace',
    params: null,
    handler: async () => ({ platform: process.platform })
  }),
  // Paired capability reads must not block this host's main loop with synchronous wsl.exe/pwsh.exe probes (up to 5s).
  defineMethod({
    name: 'host.wsl.isAvailable',
    permission: 'workspace',
    params: null,
    handler: async () => isWslAvailableAsync()
  }),
  defineMethod({
    name: 'host.wsl.listDistros',
    permission: 'workspace',
    params: null,
    handler: async () => listWslDistrosAsync()
  }),
  defineMethod({
    name: 'host.pwsh.isAvailable',
    permission: 'workspace',
    params: null,
    handler: async () => isPwshAvailableAsync()
  }),
  defineMethod({
    name: 'host.gitBash.isAvailable',
    permission: 'workspace',
    params: null,
    handler: async () => isGitBashAvailable()
  })
]
