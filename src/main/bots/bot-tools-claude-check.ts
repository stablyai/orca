import { setTimeout as delay } from 'node:timers/promises'
import { openClaudeStreamJsonConnection } from '../claude/claude-stream-json-connection'
import type { BotToolProblem } from '../../shared/bot-tools'
import { claudeLaunchServers } from './bot-tools-claude'
import type { BotToolsCli } from './bot-tools-host'
import { noteClaudeMcpConfigRefused } from '../mcp-servers/mcp-agent-problems'
import type { SessionMcpTools } from '../mcp-servers/session-mcp-tools'
import {
  CLAUDE_MCP_CONFIG_FLAG,
  claudeManagedSettingsRefuse
} from '../claude/cli-capabilities/claude-cli-flag-support'

/** Why the bot's tools are off when its owner's organization refuses --mcp-config. */
const REFUSED_BY_MANAGED_SETTINGS =
  "Off: your organization's Claude Code managed settings refuse MCP servers."

export async function claudeBotToolProblems(
  cli: BotToolsCli,
  tools: SessionMcpTools,
  signal?: AbortSignal
): Promise<Map<string, BotToolProblem>> {
  const servers = tools.servers
  // A check let go of while its launch was prepared starts no CLI.
  signal?.throwIfAborted()
  const connection = await openClaudeStreamJsonConnection({
    pathToClaudeCodeExecutable: cli.command,
    prefixArgs: cli.prefixArgs,
    cwd: cli.folder,
    env: cli.env,
    options: {
      settingSources: ['user', 'project', 'local'],
      settings: { disableAllHooks: true },
      mcpServers: claudeLaunchServers(tools),
      mcpServersDelivery: 'argv'
    }
  })
  // Aborting closes the CLI at once, failing a status request still under way.
  const closeOnAbort = (): void => void connection.close()
  signal?.addEventListener('abort', closeOnAbort, { once: true })
  let closed = false
  let problems = new Map<string, BotToolProblem>()
  try {
    const deadline = Date.now() + 30_000
    do {
      signal?.throwIfAborted()
      problems = new Map(servers.map((server) => [server.name, { kind: 'unconfirmed' }]))
      const statuses = await connection.mcpServerStatus()
      // Claude took --mcp-config and answered: managed settings don't refuse Orca's servers now.
      noteClaudeMcpConfigRefused(false)
      for (const server of statuses) {
        if (!problems.has(server.name)) {
          continue
        }
        if (server.status === 'connected') {
          problems.delete(server.name)
        } else if (server.status === 'needs-auth') {
          problems.set(server.name, { kind: 'sign-in' })
        } else if (server.status === 'failed') {
          problems.set(server.name, { kind: 'failed' })
        }
      }
      if (![...problems.values()].some((problem) => problem.kind === 'unconfirmed')) {
        break
      }
      await delay(100, undefined, { signal })
    } while (Date.now() < deadline)
  } catch (error) {
    signal?.throwIfAborted()
    if (!claudeManagedSettingsRefuse(error, CLAUDE_MCP_CONFIG_FLAG.option)) {
      throw new Error('Claude Code could not check the tools. Check its setup and try again.')
    }
    noteClaudeMcpConfigRefused(true)
    // Chats start without these tools then, so each row says why instead of a failed check.
    problems = new Map(
      servers.map((server) => [
        server.name,
        { kind: 'failed', detail: REFUSED_BY_MANAGED_SETTINGS }
      ])
    )
  } finally {
    signal?.removeEventListener('abort', closeOnAbort)
    closed = await connection.close()
  }
  if (!closed) {
    throw new Error('Claude Code tool check is still closing. Try again once it stops.')
  }
  return problems
}
