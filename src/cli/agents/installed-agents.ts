import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import type { RuntimeClient } from '../runtime/client'
import { getOptionalWorktreeSelector } from '../workspace-selection/workspace-selector'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import type { AgentLaunchSettings } from '../../shared/agent-launch/choices/agent-launch-settings'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'

type InstalledAgent = { id: TuiAgent; name: string; default: boolean }
type InstalledAgentsResult = { agents: InstalledAgent[] }

export const INSTALLED_AGENT_HANDLERS: Record<string, CommandHandler> = {
  'agent installed': async ({ flags, client, cwd, json }) => {
    const selector = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
    const worktreeId = selector
      ? (
          await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
            worktree: selector,
            matchFolderWorkspaces: true
          })
        ).result.worktree.id
      : undefined
    const [response, settings] = await Promise.all([
      client.call<TuiAgent[]>('preflight.detectAgents', worktreeId ? { worktreeId } : {}),
      readAgentLaunchSettings(client)
    ])
    // Launch refuses agents turned off in Settings → Agents, so they are not offered here.
    const disabled = new Set(settings?.disabledTuiAgents ?? [])
    const agents = response.result
      .filter((id) => !disabled.has(id))
      .map((id) => ({
        id,
        name: TUI_AGENT_DISPLAY_NAMES[id] ?? id,
        default: settings?.defaultTuiAgent === id
      }))
    printResult<InstalledAgentsResult>({ ...response, result: { agents } }, json, formatInstalled)
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
    .map((agent) => `${agent.id.padEnd(20)} ${agent.name}${agent.default ? ' (default)' : ''}`)
    .join('\n')
}
