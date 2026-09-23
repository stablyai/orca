import { defineMethod } from '../core'
import { isPwshAvailableAsync } from '../../../pwsh'
import {
  getWslHomeAsync,
  isWslAvailableAsync,
  listRunningWslDistrosAsync,
  listWslDistrosAsync
} from '../../../wsl'
import { isGitBashAvailable } from '../../../git-bash'
import { z } from 'zod'

// Why a schema: this probe takes renderer-supplied input, and an unvalidated
// distro lets unique junk keys spawn unbounded wsl.exe probes (the cache only
// dedupes identical keys). Only installed distros get a probe at all.
const DistroHomeParams = z.object({
  distro: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/)
})

export const HOST_CAPABILITY_METHODS = [
  defineMethod({
    name: 'host.platform',
    params: null,
    handler: async () => ({ platform: process.platform })
  }),
  // Why: paired web/mobile clients route capability reads here, so a sync probe would
  // execFileSync wsl.exe/pwsh.exe on this host's main event loop for up to 5s per call.
  defineMethod({
    name: 'host.wsl.isAvailable',
    params: null,
    handler: async () => isWslAvailableAsync()
  }),
  defineMethod({
    name: 'host.wsl.listDistros',
    params: null,
    handler: async () => listWslDistrosAsync()
  }),
  // Why: paired web/mobile clients render the same Add Project host picker and
  // need the running set + home probe behind the same two IPC shapes.
  defineMethod({
    name: 'host.wsl.listRunningDistros',
    params: null,
    handler: async () => listRunningWslDistrosAsync()
  }),
  defineMethod({
    name: 'host.wsl.getDistroHome',
    params: DistroHomeParams,
    handler: async (params) => {
      if (!(await listWslDistrosAsync()).includes(params.distro)) {
        return { home: null }
      }
      return { home: await getWslHomeAsync(params.distro) }
    }
  }),
  defineMethod({
    name: 'host.pwsh.isAvailable',
    params: null,
    handler: async () => isPwshAvailableAsync()
  }),
  defineMethod({
    name: 'host.gitBash.isAvailable',
    params: null,
    handler: async () => isGitBashAvailable()
  })
]
