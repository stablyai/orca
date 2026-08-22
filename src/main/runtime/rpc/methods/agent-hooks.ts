import { defineMethod, type RpcMethod } from '../core'
import { getAgentHookHostReports } from '../../../agent-hooks/agent-hook-host-reports'
import { listActiveSshAgentHookReports } from '../../../ipc/ssh'

export const AGENT_HOOK_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'agentHooks.status',
    params: null,
    // Why (#8711): only the running runtime knows which SSH hosts are live, so
    // the truthful per-host answer has to come from here — the CLI on its own
    // can see nothing but the local machine.
    handler: () => ({ hosts: getAgentHookHostReports(listActiveSshAgentHookReports) })
  })
]
