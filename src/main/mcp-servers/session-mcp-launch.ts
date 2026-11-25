// Which MCP servers a new chat session gets from Orca, decided on the host that runs it: a bot's own
// tools in its home folder, and the host's list for every session (a bot only when it opts in),
// filtered by the session's agent and workspace. With the host's switch off, only a bot's own.
import { mcpServerWorkspaceKeyOf } from '../../shared/mcp-servers/mcp-servers'
import type { Bot } from '../../shared/bot-types'
import { readBotLaunchServers } from '../bots/bot-tools-file'
import type { BotLaunchedTools } from '../bots/bot-tools-revision'
import { botToolRelay, type BotToolRelay } from '../bots/tool-relay/bot-tool-relay'
import { mcpServersForLaunch } from './mcp-host-list'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { botHostMcpAccess } from './bot-host-mcp-access'
import { isMcpServersFeatureEnabled } from './mcp-servers-feature'
import { SessionMcpTools, type SessionHostMcpServers } from './session-mcp-tools'

type LaunchRecord = { provider: string; location: { workspaceId: string } }

/** The host list's servers for this launch, maybe none; undefined with the switch off, or when the
 *  list can't be read. */
async function hostServersFor(
  agent: string,
  workspace: { key: string | null } | 'any',
  given: string | undefined
): Promise<SessionHostMcpServers | undefined> {
  if (!isMcpServersFeatureEnabled()) {
    return undefined
  }
  const folder = given ?? mcpHostListFolder()
  try {
    const servers = await mcpServersForLaunch(agent, workspace, folder)
    return { folder, servers }
  } catch (error) {
    // A broken list never stops a chat starting; its settings page shows the file's problem.
    console.warn(
      '[mcp-servers] the host list could not be read; this session starts without it',
      error
    )
    return undefined
  }
}

/**
 * The session's servers. `bot` is the bot whose home the session runs in, or null; its `launched`
 * is what its next turns compare against to pick up a tools change. A host-list change applies to
 * new sessions only.
 */
export async function sessionMcpLaunchTools(
  bot: Pick<Bot, 'id' | 'hostMcpServers'> | null,
  record: LaunchRecord,
  launchDirectory: string,
  deps: { relay?: Pick<BotToolRelay, 'grant'>; hostFolder?: string } = {}
): Promise<{ tools: SessionMcpTools; launched: BotLaunchedTools | null }> {
  const relay = deps.relay ?? botToolRelay
  if (bot) {
    const own = await readBotLaunchServers(launchDirectory)
    // A bot's home isn't one of the user's workspaces: it takes every server on for its agent.
    // A list it can't read keeps the token's reach, so the bot's running chats keep theirs.
    const host = bot.hostMcpServers
      ? ((await hostServersFor(record.provider, 'any', deps.hostFolder)) ??
        botHostMcpAccess(true, deps.hostFolder))
      : undefined
    const tools = await SessionMcpTools.for(
      relay,
      { bot: { botId: bot.id, folder: launchDirectory }, agent: record.provider },
      { own: own.servers, ...(host ? { host } : {}) }
    )
    return { tools, launched: own.launched }
  }
  const key = mcpServerWorkspaceKeyOf(record.location.workspaceId)
  const host = await hostServersFor(record.provider, { key }, deps.hostFolder)
  if (!host || host.servers.length === 0) {
    return { tools: SessionMcpTools.none, launched: null }
  }
  return {
    tools: await SessionMcpTools.for(relay, { bot: null, agent: record.provider }, { host }),
    launched: null
  }
}
