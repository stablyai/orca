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

// Why: this RPC surface serves the CLI / hosted-runtime callers, which don't
// have desktop settings. Custom agent presets (issue #2284) only exist in the
// desktop GlobalSettings store and are surfaced via the IPC preflight handler
// (`src/main/ipc/preflight.ts`). Passing `[]` here means CLI/runtime callers
// see built-in agents only. If a hosted runtime ever needs custom presets,
// wire them via the runtime store and replace the empty array.
const NO_CUSTOM_AGENTS: Parameters<typeof detectInstalledAgents>[0] = []

export const PREFLIGHT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'preflight.check',
    params: PreflightCheck,
    handler: async (params) => runPreflightCheck(params.force)
  }),
  defineMethod({
    name: 'preflight.detectAgents',
    params: null,
    handler: async () => detectInstalledAgents(NO_CUSTOM_AGENTS)
  }),
  defineMethod({
    name: 'preflight.detectRemoteAgents',
    params: PreflightDetectRemoteAgents,
    handler: async (params) => detectRemoteAgents({ ...params, customAgents: NO_CUSTOM_AGENTS })
  }),
  defineMethod({
    name: 'preflight.refreshAgents',
    params: null,
    handler: async () => refreshShellPathAndDetectAgents(NO_CUSTOM_AGENTS)
  })
]
