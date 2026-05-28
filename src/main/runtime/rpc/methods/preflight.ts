import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import {
  detectRemoteAgents,
  detectInstalledAgents,
  refreshShellPathAndDetectAgents,
  runPreflightCheck
} from '../../../ipc/preflight'

const PreflightCheck = z.object({
  force: z.boolean().optional()
})
const PreflightDetectRemoteAgents = z.object({
  connectionId: z.string().min(1)
})

export const PREFLIGHT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'preflight.check',
    params: PreflightCheck,
    handler: async (params) => runPreflightCheck(params.force)
  }),
  defineMethod({
    name: 'preflight.detectAgents',
    params: null,
    handler: async () => detectInstalledAgents()
  }),
  defineMethod({
    name: 'preflight.detectRemoteAgents',
    params: PreflightDetectRemoteAgents,
    handler: async (params) => detectRemoteAgents(params)
  }),
  defineMethod({
    name: 'preflight.refreshAgents',
    params: null,
    handler: async () => refreshShellPathAndDetectAgents()
  })
]
