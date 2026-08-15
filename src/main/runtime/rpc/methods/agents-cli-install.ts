import { z } from 'zod'
import { INSTALLABLE_TUI_AGENTS } from '../../../../shared/tui-agent-install-commands'
import { defineMethod, type RpcMethod } from '../core'
import { installTuiAgentClis } from '../../../tui-agent-cli-install-service'

const InstallableAgentSchema = z.enum(INSTALLABLE_TUI_AGENTS)

export const AgentsInstallCliRequest = z
  .object({
    agents: z.array(InstallableAgentSchema).min(1).max(32)
  })
  .strict()

export const AGENTS_CLI_INSTALL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'agents.installCli',
    params: AgentsInstallCliRequest,
    // Why: server builds install commands from the allowlisted catalog; the
    // client only sends agent ids, never raw shell.
    handler: async (params) => installTuiAgentClis(params.agents)
  })
]
