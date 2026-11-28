// How an MCP server reads on the phone: its address cut to what a row has room for, and the agents
// and workspaces it's on for, in the mocks' words.
import { botToolSubtitle, botToolTitle } from '../../../src/shared/bots/bot-tool-labels'
import {
  MCP_SERVER_CATALOG,
  type McpServerCatalogEntry
} from '../../../src/shared/mcp-servers/mcp-server-catalog'
import type { Translate } from '../i18n/mobile-i18n'
import type { PhoneMcpServer, PhoneMcpWorkspaces } from './mcp-server-operations'

export const ALL_MCP_WORKSPACES: PhoneMcpWorkspaces = { later: true, on: [], off: [] }

function listOf(names: readonly string[], intlLocale: string): string {
  return new Intl.ListFormat(intlLocale, { type: 'unit', style: 'short' }).format(names)
}

/** `mcp.linear.app` on a row, `mcp.linear.app/mcp` under a page's title; a command as `npx server-postgres`. */
export function mcpServerAddress(
  server: Pick<PhoneMcpServer, 'detail' | 'transport'>,
  withPath: boolean
): string {
  if (server.transport === 'command') {
    const program = server.detail.split(/\s+/)[0] ?? ''
    const runs = botToolSubtitle({ detail: server.detail, remote: false })
    return runs === program ? program : `${program} ${runs}`
  }
  if (!withPath) {
    return botToolSubtitle({ detail: server.detail, remote: true })
  }
  try {
    const url = new URL(server.detail)
    return `${url.host}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return server.detail
  }
}

/** The catalog's entry for a server added from it, matched by name or by address. */
export function mcpCatalogEntryOf(
  server: Pick<PhoneMcpServer, 'name' | 'detail'>
): McpServerCatalogEntry | undefined {
  const host = botToolSubtitle({ detail: server.detail, remote: true })
  return (
    MCP_SERVER_CATALOG.find((entry) => entry.id === server.name) ??
    MCP_SERVER_CATALOG.find(
      (entry) => !entry.variable && botToolSubtitle({ detail: entry.url, remote: true }) === host
    )
  )
}

/** "Linear" for a catalog app, else the server's own name with its first letter raised. */
export const mcpServerTitle = (server: Pick<PhoneMcpServer, 'name' | 'detail'>): string =>
  mcpCatalogEntryOf(server)?.name ?? botToolTitle(server.name)

/** "All agents" or "6 of 9", over the host's installed agents; null until they're read. */
export function mcpAgentsValue(
  agentsOff: readonly string[],
  agents: readonly string[] | null,
  t: Translate
): string | null {
  const all = t('mcpServers.allAgents', 'All agents')
  if (agents === null) {
    return agentsOff.length === 0 ? all : null
  }
  const on = agents.filter((agent) => !agentsOff.includes(agent)).length
  return on === agents.length
    ? all
    : t('mcpServers.agentsOf', '{{on}} of {{total}}', { on, total: agents.length })
}

/** Every workspace, including ones added later. */
export const isAllMcpWorkspaces = (workspaces: PhoneMcpWorkspaces): boolean =>
  workspaces.later && workspaces.off.length === 0

export const isMcpWorkspaceOn = (workspaces: PhoneMcpWorkspaces, key: string): boolean =>
  workspaces.on.includes(key) || (workspaces.later && !workspaces.off.includes(key))

/** "All", "All but orca-docs", "orca" or "None"; `names` maps a workspace key to its name. */
export function mcpWorkspacesValue(
  workspaces: PhoneMcpWorkspaces,
  names: ReadonlyMap<string, string>,
  t: Translate,
  intlLocale: string
): string {
  // Past two names a row's value would crowd its label out, so it counts them instead.
  const named = (keys: readonly string[]) =>
    keys.length > 2
      ? t('mcpServers.workspacesCount', '{{count}} workspaces', { count: keys.length })
      : listOf(
          keys.map((key) => names.get(key) ?? key.replace(/^folder:/, '')),
          intlLocale
        )
  if (workspaces.later) {
    const { off } = workspaces
    return off.length === 0
      ? t('mcpServers.workspacesAll', 'All')
      : off.length > 2
        ? t('mcpServers.workspacesAllButCount', 'All but {{count}}', { count: off.length })
        : t('mcpServers.workspacesAllBut', 'All but {{names}}', { names: named(off) })
  }
  return workspaces.on.length === 0 ? t('mcpServers.workspacesNone', 'None') : named(workspaces.on)
}

/**
 * Ticks or unticks one workspace. From All, a tick picks only that one; otherwise the choice for
 * workspaces added later stays as it was.
 */
export function toggleMcpWorkspace(
  workspaces: PhoneMcpWorkspaces,
  key: string
): PhoneMcpWorkspaces {
  if (isAllMcpWorkspaces(workspaces)) {
    return { later: false, on: [key], off: [] }
  }
  const on = isMcpWorkspaceOn(workspaces, key)
  const rest = {
    later: workspaces.later,
    on: workspaces.on.filter((other) => other !== key),
    off: workspaces.off.filter((other) => other !== key)
  }
  if (workspaces.later) {
    return on ? { ...rest, off: [...rest.off, key] } : rest
  }
  return on ? rest : { ...rest, on: [...rest.on, key] }
}
