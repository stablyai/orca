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
  // Why: paired web/mobile clients route capability reads here, so a sync probe would
  // execFileSync wsl.exe/pwsh.exe on this host's main event loop for up to 5s per call.
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
