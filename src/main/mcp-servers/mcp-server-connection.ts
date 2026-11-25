// What `orca mcp connect` bridges an agent to, decided on the host for the session that started it.
// Only this host's own agents ask (the bridge always runs beside them), and never a Look around or a
// bot that hasn't opted in to the host list: those sessions get no host servers at launch either.
import type { McpServerConnection } from '../../shared/mcp-servers/mcp-servers'
import { mcpServerWorkspaceKeyOf } from '../../shared/mcp-servers/mcp-servers'
import type { BotController } from '../bots/bot-controller'
import type { BotLookAroundStore } from '../bots/bot-look-around-store'
import { botOfCaller, botOfToken } from '../bots/bot-of-caller'
import { botOfHomeWorkspace } from '../../shared/bots/bot-homes'
import {
  botToolRelay,
  MCP_HOST_LIST_RELAY_OWNER,
  relayToolUrl,
  type BotToolRelay
} from '../bots/tool-relay/bot-tool-relay'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { readAgentMcpServers } from './agent-configs/agent-mcp-config-read'
import { MCP_CONFIG_AGENTS } from './agent-configs/agent-mcp-config-locations'
import { mcpServerForLaunch } from './mcp-host-list-launch'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { McpServersError } from './mcp-servers-error'

export type McpConnectCaller = {
  id: string
  agent: string
  workspaceId: string | null
  /** The agent's folder; a server its own project files name runs from there instead. */
  cwd?: string
  botToken?: string
  callerSessionId?: string
  pairedDeviceId?: string
}

type CallerRuntime = {
  bots: Pick<BotController, 'enabled' | 'list'>
  lookAround: Pick<BotLookAroundStore, 'botOfLook' | 'botOfTidyUp'>
}

const notForCaller = (message: string): McpServersError =>
  new McpServersError('mcp_server_not_for_caller', message)

/** Where the caller's session may take servers from: one workspace, or any (a bot that opted in). */
function callerWorkspace(
  runtime: CallerRuntime,
  caller: McpConnectCaller
): { key: string | null } | 'any' {
  if (caller.pairedDeviceId !== undefined) {
    throw notForCaller('Only agents on this host connect to its MCP servers.')
  }
  const session = caller.callerSessionId
  if (
    session &&
    (runtime.lookAround.botOfLook(session) !== null ||
      runtime.lookAround.botOfTidyUp(session) !== null)
  ) {
    throw notForCaller('A read-only session gets no MCP servers.')
  }
  const byToken = botOfToken(runtime, caller.botToken, undefined)
  if (byToken.kind === 'ended') {
    throw notForCaller('This bot run’s Orca token has ended.')
  }
  // An agent that starts its MCP servers with a bare environment drops the token and session id;
  // its working folder still names the bot's home.
  const bot =
    byToken.kind === 'bot'
      ? byToken.bot
      : (botOfCaller(runtime, session, undefined) ??
        (runtime.bots.enabled()
          ? botOfHomeWorkspace(runtime.bots.list(), caller.workspaceId)
          : null))
  if (bot) {
    if (!bot.hostMcpServers) {
      throw notForCaller(`${bot.name} doesn’t use this host’s MCP servers.`)
    }
    // A bot's home isn't one of the user's workspaces: it takes every server on for its agent.
    return 'any'
  }
  return { key: caller.workspaceId === null ? null : mcpServerWorkspaceKeyOf(caller.workspaceId) }
}

/** The server names the agent's own project files in `cwd` define (`.cursor/mcp.json` and the like). */
async function projectNamesIn(agent: string, cwd: string): Promise<Set<string>> {
  const configAgent = MCP_CONFIG_AGENTS.find((known) => known === agent)
  if (!configAgent || !isAbsolute(cwd)) {
    return new Set()
  }
  const servers = await readAgentMcpServers(
    configAgent,
    { homeDir: homedir(), env: process.env, platform: process.platform },
    { projectPath: cwd }
  )
  return new Set(
    servers.filter(({ source }) => source.scope === 'project').map(({ configName }) => configName)
  )
}

export async function mcpServerConnection(
  runtime: CallerRuntime,
  caller: McpConnectCaller,
  deps: { relay?: Pick<BotToolRelay, 'grant'>; folder?: string } = {}
): Promise<McpServerConnection> {
  const workspace = callerWorkspace(runtime, caller)
  const folder = deps.folder ?? mcpHostListFolder()
  const server = await mcpServerForLaunch(caller.id, caller.agent, workspace, folder)
  if (
    !server ||
    (caller.cwd && (await projectNamesIn(caller.agent, caller.cwd)).has(server.name))
  ) {
    return { on: false }
  }
  if (!('url' in server)) {
    return { on: true, command: server.command, args: server.args, env: server.env ?? {} }
  }
  if (!server.credential) {
    // Header values live in the credential store; one still in the file was never moved, so it
    // never launches (as SessionMcpTools refuses it).
    return Object.keys(server.headers ?? {}).length > 0
      ? { on: false }
      : { on: true, url: server.url, headers: {} }
  }
  const { origin, token } = await (deps.relay ?? botToolRelay).grant(MCP_HOST_LIST_RELAY_OWNER, {
    host: folder
  })
  return {
    on: true,
    url: relayToolUrl(origin, 'host', server.credential),
    headers: { authorization: `Bearer ${token}` }
  }
}
