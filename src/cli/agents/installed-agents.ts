import type { CommandHandler } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { getOptionalWorktreeSelector } from '../workspace-selection/workspace-selector'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'

type InstalledAgent = { id: TuiAgent; name: string }
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
    const response = await client.call<TuiAgent[]>(
      'preflight.detectAgents',
      worktreeId ? { worktreeId } : {}
    )
    const agents = response.result.map((id) => ({ id, name: TUI_AGENT_DISPLAY_NAMES[id] ?? id }))
    printResult<InstalledAgentsResult>({ ...response, result: { agents } }, json, formatInstalled)
  }
}

function formatInstalled({ agents }: InstalledAgentsResult): string {
  if (agents.length === 0) {
    return 'No agent CLIs found on this host.'
  }
  return agents.map((agent) => `${agent.id.padEnd(20)} ${agent.name}`).join('\n')
}
