// Reads of the host list's file that open no saved sign-in: the credential store stays shut, so
// discovery and imports can ask them on every refresh.
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { BotToolServerSchema, type BotToolServer } from '../../shared/bot-tools'
import type { McpAgentFiles, McpServer } from '../../shared/mcp-servers/mcp-servers'
import { parseJsonObject } from '../../shared/workspace-setup/setup-script-import-parsers'
import { botToolsPath } from '../bots/bot-tools-path'
import { agentFilesOf, storedView } from './mcp-host-list'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { pluginMarkOf } from './mcp-plugin-server-mark'

const RawEntriesSchema = z.array(z.record(z.string(), z.unknown())).catch([])

/** The file as written; empty when absent or unreadable. */
async function readHostFile(folder: string): Promise<Record<string, unknown>> {
  const text = await readFile(botToolsPath(folder), 'utf8').catch(() => null)
  return parseJsonObject(text) ?? {}
}

/** Which agents' own MCP file the user let Orca keep its servers in. */
export async function readMcpAgentFiles(folder = mcpHostListFolder()): Promise<McpAgentFiles> {
  return agentFilesOf(await readHostFile(folder))
}

/**
 * The user's own server whose definition matches (`same`): not a plugin's, and without a saved
 * sign-in or headers, which can't be compared. Null when there is none.
 */
export async function findOwnMcpServer(
  same: (server: BotToolServer) => boolean,
  folder = mcpHostListFolder()
): Promise<McpServer | null> {
  const entries = RawEntriesSchema.parse((await readHostFile(folder)).servers)
  const id = entries.find((raw) => {
    const server = BotToolServerSchema.safeParse(raw).data
    const signedIn = server && 'credential' in server && server.credential
    return server && !signedIn && !pluginMarkOf(raw) && same(server)
  })?.id
  return typeof id === 'string' ? storedView(folder, id) : null
}
