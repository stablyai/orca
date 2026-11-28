import { z } from 'zod'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { AgentSessionModelCatalogResult } from '../../shared/agent-session/agent-session-wire'
import { readAgentSessionUnavailable } from '../../shared/agent-session/failures/agent-session-availability'
import { installedAgentRefusal } from '../../shared/agent-launch/catalog/tui-agent-selection'
import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { AGENT_MODEL_CATALOG_REQUEST_TIMEOUT_MS } from '../../shared/agent-session/options/model-catalog/agent-model-catalog-request-timeout'
import { isNativeChatAgent } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import { finishedListingIds } from '../../shared/agent-session/options/model-catalog/structured-agent-session-listing-verified-ids'
import { getAgentSessionOptionLaunchCatalog } from '../../shared/agent-session/options/agent-session-option-catalog'
import {
  parseRoutableExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host/execution-host'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration/orchestration-compatibility-evidence'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import { getRequiredStringFlag } from '../arguments/flags'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getWslCallerDistro } from '../hosts/wsl-caller-distro'
import { printResult } from '../output/command-result-output'
import { isLaunchedByAnotherRuntime } from '../runtime/connection/runtime-source-fence'
import { RuntimeClientError } from '../runtime/connection/types'
import { getCallerWorkspaceIds } from '../workspace-selection/caller-host-worktree-selection'
import {
  getRequiredWorktreeSelector,
  resolveCurrentWorktreeSelector
} from '../workspace-selection/workspace-selector'
import { parseCliAgent } from './agent-launch-request'
import { readInstalledAgents } from './installed-agents'

const CatalogHostStatus = z.object({
  runtimeId: z.string(),
  capabilities: z.array(z.string()).optional()
})

async function modelWorkspace({ flags, client, cwd }: HandlerContext) {
  let selector: string | undefined
  let callerHost: string | undefined
  if (flags.has('worktree')) {
    selector = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
  } else if (!client.isRemote && !isLaunchedByAnotherRuntime(process.env, client.userDataPath)) {
    const host = readOrchestrationCompatibilityEvidence(process.env)?.host
    if (getWslCallerDistro(cwd) || host?.kind === 'wsl') {
      throw new RuntimeClientError(
        'capability_unsupported',
        'To list models in WSL, query an Orca runtime running inside that distro.'
      )
    }
    if (process.env.ORCA_CLI_CWD && !host) {
      throw new RuntimeClientError(
        'worktree_execution_host_unresolved',
        'This forwarded shell did not identify its execution host. Pass --worktree with an exact workspace selector.'
      )
    }
    const [id] = getCallerWorkspaceIds()
    if (host?.kind === 'ssh') {
      callerHost = toSshExecutionHostId(host.targetId)
      selector = id ? `id:${id}` : await resolveCurrentWorktreeSelector(cwd, client)
    } else if (id) {
      selector = `id:${id}`
    }
  }
  if (!selector) {
    return undefined
  }
  const response = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector,
    matchFolderWorkspaces: true
  })
  const { worktree } = response.result
  if (
    !parseRoutableExecutionHostId(worktree.hostId) ||
    (callerHost && worktree.hostId !== callerHost)
  ) {
    throw new RuntimeClientError(
      'worktree_execution_host_unresolved',
      'Orca could not verify the execution host for this workspace. Check its address with orca worktree show.'
    )
  }
  return response
}

async function modelCatalogRequest(ctx: HandlerContext, agent: TuiAgent) {
  const workspace = await modelWorkspace(ctx)
  if (workspace) {
    const { worktree } = workspace.result
    return {
      method: 'preflight.agentModels',
      params: { agent, worktreeId: worktree.id, worktreeHostId: worktree.hostId },
      runtimeId: workspace._meta.runtimeId
    }
  }
  const { result, _meta } = await readInstalledAgents(ctx.client)
  const refusal = installedAgentRefusal(agent, result.agents, result.settings?.disabledTuiAgents)
  if (refusal) {
    throw new RuntimeClientError(refusal.code, refusal.message, refusal.data)
  }
  return {
    method: 'agentSession.modelCatalog',
    params: { agent, waitForListing: true },
    runtimeId: _meta.runtimeId
  }
}

function listedCatalog(agent: string, catalog: AgentSessionModelCatalogResult) {
  if (
    catalog.origin !== 'unknown' &&
    !catalog.waitExpired &&
    finishedListingIds(catalog)?.every((id) => id.trim())
  ) {
    return { agent, ...catalog }
  }
  const reason = readAgentSessionUnavailable(catalog.unavailable)?.reason
  const reasons = {
    cliMissing: 'The agent CLI is missing.',
    agentCommandNotRunnable: 'The configured agent command cannot run.',
    notSignedIn: 'The provider account is signed out.'
  }
  const message = catalog.waitExpired
    ? 'Timed out waiting for the provider to finish listing models. Try again.'
    : reason
      ? reasons[reason]
      : catalog.listingInProgress
        ? 'The model listing is still in progress. Try again.'
        : 'The provider did not return a model listing for this host and workspace.'
  throw new RuntimeClientError(
    catalog.waitExpired ? 'model_catalog_timeout' : 'model_catalog_unavailable',
    `${agent}: ${message}`,
    {
      agent,
      ...catalog
    }
  )
}

export const AGENT_MODEL_HANDLERS: Record<string, CommandHandler> = {
  'agent models': async (ctx) => {
    const { flags, client, json } = ctx
    const agent = parseCliAgent(getRequiredStringFlag(flags, 'agent'))
    if (!getAgentSessionOptionLaunchCatalog(agent)?.supportsWorkerLaunchPreferences) {
      throw new RuntimeClientError(
        'capability_unsupported',
        `Agent ${agent} does not support --model at launch.`
      )
    }
    if (!isNativeChatAgent(agent)) {
      throw new RuntimeClientError(
        'capability_unsupported',
        `The host model catalog does not support discovery for ${agent}.`
      )
    }
    try {
      const { method, params, runtimeId } = await modelCatalogRequest(ctx, agent)
      const response = await client.call<AgentSessionModelCatalogResult>(method, params, {
        timeoutMs: AGENT_MODEL_CATALOG_REQUEST_TIMEOUT_MS,
        requestSelection: {
          paramsForStatus: (raw) => {
            const status = CatalogHostStatus.safeParse(raw)
            if (
              !status.success ||
              !status.data.capabilities?.includes(AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY)
            ) {
              throw new RuntimeClientError(
                'incompatible_runtime',
                'Update Orca on the connected host to discover provider model IDs.'
              )
            }
            if (status.data.runtimeId !== runtimeId) {
              throw new RuntimeClientError(
                'runtime_unavailable',
                'The connected Orca runtime changed after selecting the agent or workspace. Run the command again.'
              )
            }
            return params
          }
        }
      })
      const result = listedCatalog(agent, response.result)
      printResult({ ...response, result }, json, ({ models }) =>
        models
          .map((row) => `${row.id}\t${row.label}${row.isDefault ? ' (default)' : ''}`)
          .join('\n')
      )
    } catch (error) {
      if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'Update Orca on the connected host and the workspace host to list agent models.'
        )
      }
      throw error
    }
  }
}
