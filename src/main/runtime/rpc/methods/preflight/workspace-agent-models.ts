import type { z } from 'zod'
import { installedAgentRefusal } from '../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { PreflightAgentModels } from '../../../../../shared/rpc-contract/preflight/preflight-params'
import { getPreflightWslTarget } from '../../../../ipc/preflight/preflight-runtime-target'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import type { RpcContext } from '../../core'
import { requireStructuredAgentAudience } from '../structured-sessions/creation/structured-agent-session-gate'
import { readInstalledAgentsOnHost, readOnWorkspaceAgentHost } from './installed-agents'

export function readWorkspaceAgentModels(
  params: z.infer<typeof PreflightAgentModels>,
  ctx: RpcContext
) {
  const { agent } = params
  requireStructuredAgentAudience(ctx, agent)
  return readOnWorkspaceAgentHost(
    ctx.runtime,
    params,
    { method: 'preflight.agentModels', agent },
    async (host, path) => {
      if (host.kind !== 'local' || getPreflightWslTarget(host.context)) {
        throw new OrchestrationError(
          'capability_unsupported',
          'This workspace runs agents outside the native Orca host. Query an Orca runtime running on its execution host.'
        )
      }
      // A catalog read with an unresolved folder can return the host account's models.
      const workspacePath = await ctx.runtime.resolveStructuredAgentCatalogWorkspacePath(
        `id:${params.worktreeId}`
      )
      if (!workspacePath || workspacePath !== path) {
        throw new OrchestrationError(
          'resource_server_mismatch',
          'Orca could not verify the workspace folder for this model catalog.'
        )
      }
      const { agents, settings } = await readInstalledAgentsOnHost(ctx.runtime, host, agent)
      const refusal = installedAgentRefusal(agent, agents, settings.disabledTuiAgents)
      if (refusal) {
        throw new OrchestrationError(refusal.code, refusal.message, refusal.data)
      }
      const catalog = await ctx.runtime.structuredAgentModelCatalog()
      return catalog
        ? catalog.read({ agent, workspacePath, waitForListing: true, progress: true })
        : { origin: 'unknown' }
    }
  )
}
