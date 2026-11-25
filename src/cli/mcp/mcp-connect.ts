// `orca mcp connect <id> --agent <agent>`: the entry Orca keeps in Grok's, Cursor's and Droid's own
// MCP file. It asks the Orca its entry pins (ORCA_USER_DATA_PATH) which server that is for this
// session and bridges the agent's stdio to it. It never opens Orca, and never writes to stdout
// anything but the protocol: a failure is one line on stderr.
import type { McpServerConnection } from '../../shared/mcp-servers/mcp-servers'
import {
  readInjectedAgentSessionId,
  readInjectedBotToken
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { CommandHandler } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/connection/types'
import { resolveCurrentWorktreeSelection } from '../workspace-selection/workspace-selector'
import { readOrcaCliVersion } from '../cli-version'
import { bridgeMcpServer } from './mcp-connect-bridge'

/**
 * The session's workspace: the Orca pane's own (WSL forwards it), else the one holding cwd; null
 * outside every workspace, `unknown` when cwd can't be pinned to one (two repos claim it).
 */
async function workspaceOf(client: RuntimeClient, cwd: string): Promise<string | null | 'unknown'> {
  const own = process.env.ORCA_WORKSPACE_ID?.trim()
  if (own) {
    return own
  }
  try {
    return (await resolveCurrentWorktreeSelection(cwd, client, 'current')).worktreeId
  } catch (error) {
    if (!(error instanceof RuntimeClientError) || !error.code.startsWith('selector_')) {
      throw error
    }
    // Outside every workspace, the server follows its "workspaces added later" choice.
    return error.code === 'selector_not_found' ? null : 'unknown'
  }
}

/** The host's answer; any refusal (switch off, a Look around, an older host) is a server with no tools. */
async function readConnection(
  client: RuntimeClient,
  params: { id: string; agent: string; cwd: string }
): Promise<McpServerConnection> {
  const botToken = readInjectedBotToken()
  const callerSessionId = readInjectedAgentSessionId()
  try {
    const workspaceId = await workspaceOf(client, params.cwd)
    if (workspaceId === 'unknown') {
      // A server may be off in one of the workspaces: offer none rather than guess.
      return { on: false }
    }
    const response = await client.call<McpServerConnection>('mcpServers.connect', {
      id: params.id,
      agent: params.agent,
      workspaceId,
      ...(botToken ? { botToken } : {}),
      ...(callerSessionId ? { callerSessionId } : {})
    })
    return response.result
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError) {
      return { on: false }
    }
    throw error
  }
}

const connect: CommandHandler = async ({ flags, client, cwd }) => {
  const id = getRequiredStringFlag(flags, 'id')
  const agent = getRequiredStringFlag(flags, 'agent')
  try {
    process.exitCode = await bridgeMcpServer(
      () => readConnection(client, { id, agent, cwd }),
      readOrcaCliVersion() ?? '0.0.0'
    )
  } catch (error) {
    // Orca isn't running (or can't be reached): the agent shows this server as failed to start.
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(`orca mcp connect: ${reason}\n`)
    process.exitCode = 1
  }
}

export const MCP_HANDLERS: Record<string, CommandHandler> = { 'mcp connect': connect }
