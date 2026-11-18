// A bot's Composio tool: its Composio user's session MCP server, kept among the bot's own tools; Orca's
// relay adds the owner's key to each call, so the bot never holds it.
import {
  COMPOSIO_HEADER_SOURCE,
  COMPOSIO_SESSION_MCP_URL,
  COMPOSIO_TOOL_NAME,
  composioUserOfBot
} from '../../shared/composio/composio-apps'
import { freeBotToolName, type BotToolServer } from '../../shared/bot-tools'
import { addBotTool, inheritedTools, type BotToolsCli } from '../bots/bot-tools-host'
import { changeBotToolServers, readBotToolServers } from '../bots/bot-tools-file'
import {
  newBotToolCredentialId,
  readBotToolCredential,
  type BotToolCredential
} from '../bots/bot-tool-credentials'
import type { ComposioApi } from './composio-api'

export const composioServerOf = (servers: readonly BotToolServer[]) =>
  servers.find((server) => 'url' in server && COMPOSIO_SESSION_MCP_URL.test(server.url))

export function sessionIdOf(url: string): string | null {
  return COMPOSIO_SESSION_MCP_URL.exec(url)?.[1] ?? null
}

const sourced = (url: string): BotToolCredential => ({
  url,
  headers: {},
  source: COMPOSIO_HEADER_SOURCE
})

/** The bot's Composio tool as the host saved it: the session in the host's own credential is the
 *  authority, since the bot can edit the URL in its tools file. */
function composioToolOf(folder: string, servers: readonly BotToolServer[]) {
  for (const server of servers) {
    if (!('url' in server) || !server.credential) {
      continue
    }
    const saved = readBotToolCredential(folder, server.credential)
    if (saved?.source === COMPOSIO_HEADER_SOURCE) {
      return { server, id: server.credential, url: saved.url }
    }
  }
  return null
}

/** Makes or fixes the bot's tool: a session Composio no longer has (or another project's) is replaced
 *  in place, so the bot keeps its tool name, connections and relay address. The key itself never
 *  enters the bot's tools; the relay adds it to each call. */
export async function ensureComposioTool({
  cli,
  botId,
  call
}: {
  cli: BotToolsCli
  botId: string
  call: <T>(work: (api: ComposioApi) => Promise<T>) => Promise<T>
}): Promise<{ sessionId: string; changed: boolean }> {
  const servers = await readBotToolServers(cli.folder)
  const owned = composioToolOf(cli.folder, servers)
  // A tool the host didn't save as this bot's names a session nobody vouched for: it gets a new one.
  const existing = owned?.server ?? composioServerOf(servers)
  const sessionId = owned ? sessionIdOf(owned.url) : null
  const live = sessionId && (await call((api) => api.refreshSession(sessionId)))
  const session = live ? null : await call((api) => api.createSession(composioUserOfBot(botId)))
  if (existing && 'url' in existing) {
    const url = session?.mcpUrl ?? owned?.url
    if (!url) {
      throw new Error('Composio didn’t make a session.')
    }
    if (!session && existing.url === url) {
      return { sessionId: sessionId ?? '', changed: false }
    }
    // The same credential id keeps a running chat's relay address working on the new session.
    const id = owned?.id ?? newBotToolCredentialId()
    await changeBotToolServers(
      cli.folder,
      (current) =>
        current.map((server) =>
          server.name === existing.name
            ? { name: server.name, url, transport: 'http' as const, credential: id }
            : server
        ),
      undefined,
      undefined,
      new Map([[id, sourced(url)]])
    )
    return { sessionId: session?.id ?? sessionId ?? '', changed: true }
  }
  if (!session) {
    throw new Error('Composio didn’t make a session.')
  }
  // Names the owner's own config uses would shadow it, so they count as taken too.
  const [own, inherited] = await Promise.all([readBotToolServers(cli.folder), inheritedTools(cli)])
  const taken = new Set([
    ...own.map((server) => server.name),
    ...inherited.filter((tool) => !tool.plugin).map((tool) => tool.name)
  ])
  const id = newBotToolCredentialId()
  await addBotTool(
    cli,
    {
      name: freeBotToolName(COMPOSIO_TOOL_NAME, taken),
      url: session.mcpUrl,
      transport: 'http',
      credential: id
    },
    new Map([[id, sourced(session.mcpUrl)]])
  )
  return { sessionId: session.id, changed: true }
}
