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
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeRpcFailureError } from '../runtime/connection/types'
import { isLaunchedByAnotherRuntime } from '../runtime/connection/runtime-source-fence'
import { mcpCallerWorkspace } from './mcp-caller-workspace'
import { readOrcaCliVersion } from '../cli-version'
import { bridgeMcpServer } from '../../main/mcp-servers/agent-files/mcp-connect-bridge'

/** The host's answer; any refusal (switch off, a Look around, an older host) is a server with no tools. */
async function readConnection(
  client: RuntimeClient,
  params: {
    id: string
    agent: string
    cwd: string
    given: { workspace: string | undefined; outside: boolean }
  }
): Promise<McpServerConnection> {
  if (isLaunchedByAnotherRuntime(process.env, client.userDataPath)) {
    // Another Orca's session (its pane, chat or bot) also loads this Orca's entries from the shared
    // file; its workspace and caller ids mean nothing here, so it gets that Orca's servers only.
    return { on: false }
  }
  const botToken = readInjectedBotToken()
  const callerSessionId = readInjectedAgentSessionId()
  try {
    const workspaceId = await mcpCallerWorkspace(client, params.cwd, params.given)
    if (workspaceId === undefined) {
      // A server may be off in one of the workspaces: offer none rather than guess.
      return { on: false }
    }
    const response = await client.call<McpServerConnection>('mcpServers.connect', {
      id: params.id,
      agent: params.agent,
      workspaceId,
      cwd: params.cwd,
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
  const given = {
    workspace: getOptionalStringFlag(flags, 'workspace'),
    outside: flags.get('outside-workspace') === true
  }
  try {
    process.exitCode = await bridgeMcpServer(
      () => readConnection(client, { id, agent, cwd, given }),
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
