// A bot's tools as its agent CLI gets them for Orca's own checks and sign-ins, and the words a bot
// session hears when its tools are off. The launch shape itself is `SessionMcpTools`.
import type { BotToolProblem, BotToolServer } from '../../shared/bot-tools'
import type { BotToolsCli } from './bot-tools-host'
import { botToolRelay, MCP_HOST_LIST_RELAY_OWNER } from './tool-relay/bot-tool-relay'
import { SessionMcpTools, withSessionMcpToolsEnv } from '../mcp-servers/session-mcp-tools'
import { botHostMcpAccess } from '../mcp-servers/bot-host-mcp-access'
import { sharedMcpProcessIds } from '../mcp-servers/mcp-shared-process-servers'

/** The bot's servers as its CLI gets them for a turn, and the CLI with the env that goes with them. */
export async function cliWithLaunchTools(
  cli: BotToolsCli,
  servers: readonly BotToolServer[]
): Promise<{ cli: BotToolsCli; tools: SessionMcpTools }> {
  // The host list's checks run its servers as a non-bot session gets them, under the host's token.
  const tools =
    cli.botId === MCP_HOST_LIST_RELAY_OWNER
      ? await SessionMcpTools.for(
          botToolRelay,
          { bot: null, agent: cli.agent },
          // A shared server is checked through its one process, as sessions reach it.
          {
            host: {
              folder: cli.folder,
              servers,
              sharedProcesses: await sharedMcpProcessIds(cli.folder)
            }
          }
        )
      : await SessionMcpTools.for(
          botToolRelay,
          { bot: { botId: cli.botId, folder: cli.folder }, agent: cli.agent },
          // The bot's token is its running chats' too: a check keeps their reach to the host list.
          { own: servers, host: botHostMcpAccess(cli.hostMcpServers === true) }
        )
  return { cli: { ...cli, env: withSessionMcpToolsEnv(cli.env, tools) }, tools }
}

/** A relayed tool's server that refused its saved values says so on the row. */
export function withRelayProblems(
  cli: BotToolsCli,
  servers: readonly BotToolServer[],
  problems: Record<string, BotToolProblem>
): Record<string, BotToolProblem> {
  const out = { ...problems }
  for (const server of servers) {
    const detail =
      'url' in server && server.credential
        ? botToolRelay.lastProblem(cli.folder, server.credential)
        : null
    if (detail && out[server.name]) {
      out[server.name] = { kind: 'failed', detail }
    }
  }
  return out
}

/** A bot session's note that its own tools are off and `why`, so it doesn't claim or try them. */
export function botToolsOffInstruction(why: string): string {
  return `Your own tools (MCP servers) are off in this session: ${why}. Don't say you have them or try to use them.`
}
