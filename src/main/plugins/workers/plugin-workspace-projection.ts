import type { z } from 'zod'
import { shortPluginBranchName } from '../../../shared/plugins/events/plugin-events'
import {
  PLUGIN_TERMINAL_ID_MAX_LENGTH,
  PLUGIN_WORKSPACE_LABEL_MAX_LENGTH,
  PLUGIN_WORKSPACE_TERMINAL_LIMIT,
  type pluginWorkspaceContextSchema
} from '../../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_AGENT_LIST_LIMIT } from '../../../shared/plugins/workers/plugin-host-api-panel-methods'
import type { AgentStatusState } from '../../../shared/agent-status-types'

/** One terminal of a workspace, as main's runtime lists it. */
export type PluginWorkspaceTerminal = {
  /** The terminal handle plugins call `terminalId`. */
  id: string
  title?: string
  /** `tabId:leafId`, which agent statuses carry. */
  paneKey?: string
}

/** One agent row from the hook server's status store (the fields plugins may see). */
export type PluginAgentStatusRow = {
  paneKey: string
  worktreeId?: string
  terminalHandle?: string
  state: AgentStatusState
  agentType?: string
  stateStartedAt: number
  providerSessionOnly?: boolean
}

export type PluginWorkspaceContext = z.output<typeof pluginWorkspaceContextSchema>

type Context = { worktreeId: string; branch: string; displayName: string }

/** A pane's own name wins over the title its program sets. */
export function pluginTerminalTitle(terminal: {
  title: string | null
  paneTitle?: string
}): string | undefined {
  const title = (terminal.paneTitle ?? terminal.title ?? '').trim()
  return title ? title.slice(0, PLUGIN_WORKSPACE_LABEL_MAX_LENGTH) : undefined
}

/** Worktree ids embed provider paths: only these public fields reach plugins. */
export function projectPluginWorkspaceContext(
  context: Context | null,
  terminals: readonly PluginWorkspaceTerminal[]
): PluginWorkspaceContext {
  if (!context) {
    return null
  }
  return {
    branch: shortPluginBranchName(context.branch).slice(0, PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    displayName: context.displayName.slice(0, PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    terminals: terminals
      .filter(({ id }) => id.length > 0 && id.length <= PLUGIN_TERMINAL_ID_MAX_LENGTH)
      .slice(0, PLUGIN_WORKSPACE_TERMINAL_LIMIT)
      .map(({ id, title }) => (title ? { id, title } : { id }))
  }
}

/** The terminal an agent's pane is: by the handle its status names, else by pane key. */
export function terminalForPane(
  terminals: readonly PluginWorkspaceTerminal[],
  row: Pick<PluginAgentStatusRow, 'paneKey' | 'terminalHandle'>
): PluginWorkspaceTerminal | undefined {
  return (
    terminals.find((terminal) => terminal.id === row.terminalHandle) ??
    terminals.find((terminal) => terminal.paneKey === row.paneKey)
  )
}

/** `agents.list`: the focused workspace's agents, newest state first. */
export function projectPluginWorkspaceAgents(
  worktreeId: string,
  terminals: readonly PluginWorkspaceTerminal[],
  rows: readonly PluginAgentStatusRow[]
) {
  return rows
    .filter((row) => row.worktreeId === worktreeId && row.providerSessionOnly !== true)
    .toSorted((a, b) => b.stateStartedAt - a.stateStartedAt)
    .slice(0, PLUGIN_AGENT_LIST_LIMIT)
    .map((row) => {
      const terminal = terminalForPane(terminals, row)
      return {
        terminalId: terminal?.id ?? null,
        title: terminal?.title ?? null,
        agent: row.agentType?.slice(0, 128) ?? null,
        state: row.state,
        stateStartedAt: row.stateStartedAt
      }
    })
}
