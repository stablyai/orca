// Adding servers to a host's MCP server list: a paste of many is one write and one read back.
import { randomUUID } from 'node:crypto'
import { freeBotToolName, type BotToolServer } from '../../shared/bot-tools'
import type { McpServer, McpServerWorkspaces } from '../../shared/mcp-servers/mcp-servers'
import { classifyAddedBotTool } from '../bots/tool-oauth/bot-tool-owned-sign-in'
import { changeHostEntries, nameTaken, storedViews, type HostEntry } from './mcp-host-list'
import { mcpHostListFolder } from './mcp-host-list-folder'

/**
 * Adds each of `given` in one write, as a server Orca signs in to when its address asks for a
 * sign-in. A name from a paste that's taken gets a free one (`linear-2`); a name the user gave is
 * refused instead. Sorted in turn: one whose address can't be used leaves the ones before it added.
 */
export async function addMcpServers(
  given: readonly BotToolServer[],
  {
    nameGiven,
    signal,
    workspaces,
    agentsOff = []
  }: {
    nameGiven: boolean
    signal?: AbortSignal
    workspaces?: McpServerWorkspaces
    agentsOff?: readonly string[]
  },
  folder = mcpHostListFolder()
): Promise<McpServer[]> {
  const sorted: Awaited<ReturnType<typeof classifyAddedBotTool>>[] = []
  let refused: { error: unknown } | undefined
  for (const server of given) {
    try {
      sorted.push(await classifyAddedBotTool(server, signal))
    } catch (error) {
      refused = { error }
      break
    }
  }
  const ids = sorted.map(() => randomUUID())
  if (sorted.length > 0) {
    const extras = {
      ...(workspaces ? { workspaces } : {}),
      ...(agentsOff.length > 0 ? { agentsOff: [...new Set(agentsOff)] } : {})
    }
    await changeHostEntries(
      folder,
      (entries) => {
        const taken = new Set(entries.map((entry) => entry.server.name))
        const added = sorted.map(({ server }, i): HostEntry => {
          if (nameGiven && taken.has(server.name)) {
            throw nameTaken(server.name)
          }
          const name = freeBotToolName(server.name, taken)
          taken.add(name)
          return { server: { ...server, name }, extras: { ...extras, id: ids[i] }, id: ids[i]! }
        })
        return [...entries, ...added]
      },
      { credentials: new Map(sorted.flatMap(({ signIn }) => [...(signIn ?? [])])) }
    )
  }
  if (refused) {
    throw refused.error
  }
  return storedViews(folder, ids)
}
