import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { getOptionalWorktreeSelector } from '../workspace-selection/workspace-selector'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import type { AgentLaunchSettings } from '../../shared/agent-launch/choices/agent-launch-settings'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import { parseExecutionHostId } from '../../shared/execution-host/execution-host'

type InstalledAgent = { id: string; name: string; default: boolean; copyOf?: TuiAgent }
type InstalledAgentCopy = { id: string; name: string; agent: TuiAgent }
type InstalledAgentsResult = { agents: InstalledAgent[] }

export const INSTALLED_AGENT_HANDLERS: Record<string, CommandHandler> = {
  'agent installed': async ({ flags, client, cwd, json }) => {
    const selector = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
    const worktree = selector
      ? (
          await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
            worktree: selector,
            matchFolderWorkspaces: true
          })
        ).result.worktree
      : undefined
    const response = await readInstalledAgents(client, worktree)
    const { settings } = response.result
    // Launch refuses agents turned off in Settings → Agents, so they are not offered here.
    const disabled = new Set(settings?.disabledTuiAgents ?? [])
    const installed = response.result.agents.filter((id) => !disabled.has(id))
    // A copy runs its base agent's CLI, so it is offered wherever that agent is.
    const copies = (response.result.copies ?? [])
      .filter((copy) => installed.includes(copy.agent))
      .map((copy) => ({ id: copy.id, name: copy.name, default: false, copyOf: copy.agent }))
    const agents: InstalledAgent[] = [
      ...installed.map((id) => ({
        id,
        name: TUI_AGENT_DISPLAY_NAMES[id] ?? id,
        default: settings?.defaultTuiAgent === id
      })),
      ...copies
    ]
    printResult<InstalledAgentsResult>({ ...response, result: { agents } }, json, formatInstalled)
  }
}

async function readInstalledAgents(client: RuntimeClient, worktree?: RuntimeWorktreeRecord) {
  try {
    return await client.call<{
      agents: TuiAgent[]
      settings: AgentLaunchSettings | null
      copies?: InstalledAgentCopy[]
    }>(
      'preflight.installedAgents',
      worktree ? { worktreeId: worktree.id, worktreeHostId: worktree.hostId } : {}
    )
  } catch (error) {
    if (!(error instanceof RuntimeClientError) || error.code !== 'method_not_found') {
      throw error
    }
    if (worktree && parseExecutionHostId(worktree.hostId)?.kind !== 'local') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update Orca on the connected host and the workspace host to list installed agents for a workspace.'
      )
    }
    const [response, settings] = await Promise.all([
      client.call<TuiAgent[]>(
        'preflight.detectAgents',
        worktree ? { worktreeId: worktree.id, worktreeHostId: worktree.hostId } : {}
      ),
      readAgentLaunchSettings(client)
    ])
    return { ...response, result: { agents: response.result, settings } }
  }
}

async function readAgentLaunchSettings(client: RuntimeClient): Promise<AgentLaunchSettings | null> {
  try {
    return (await client.call<{ settings: AgentLaunchSettings }>('settings.getAgentLaunch')).result
      .settings
  } catch {
    // Hosts without this method still list detected agents, unfiltered.
    return null
  }
}

function formatInstalled({ agents }: InstalledAgentsResult): string {
  if (agents.length === 0) {
    return 'No enabled agent CLIs found on this host.'
  }
  return agents
    .map(
      (agent) =>
        `${agent.id.padEnd(20)} ${agent.name}${agent.default ? ' (default)' : ''}${
          agent.copyOf ? ` (copy of ${TUI_AGENT_DISPLAY_NAMES[agent.copyOf] ?? agent.copyOf})` : ''
        }`
    )
    .join('\n')
}
