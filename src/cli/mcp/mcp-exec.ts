// `orca mcp exec <id>`: an agent terminal's command server whose saved environment stays with
// Orca. The running Orca on this computer hands over the command and its environment, and this
// process becomes the server (execve), or on Windows starts it and stays as its wrapper, so the
// values never sit in the agent's config, its command line or its own environment.
import { isAbsolute, resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type { McpServerConnection } from '../../shared/mcp-servers/mcp-servers'
import { encodeMcpEnvPairs } from '../../shared/mcp-servers/mcp-env-pairs'
import { resolveCliCommand } from '../../shared/shell/command-resolution/node-cli-command-resolution'
import {
  readInjectedAgentSessionId,
  readInjectedBotToken
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { mcpCallerWorkspace } from './mcp-caller-workspace'

type CommandServer = { command: string; args: string[]; env: Record<string, string> }

// What Orca's launchers set or move aside to run this CLI under Electron; the server gets the
// environment the agent started it with instead.
const LAUNCHER_ENV = [
  'ORCA_USER_DATA_PATH',
  'ELECTRON_RUN_AS_NODE',
  'ORCA_APP_EXECUTABLE',
  'ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT',
  'ORCA_NODE_OPTIONS',
  'ORCA_NODE_REPL_EXTERNAL_MODULE',
  'ORCA_CLI_HANDOFF',
  'ORCA_CLI_ELECTRON_EXECUTABLE',
  'ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER'
] as const

/** The server's environment: the agent's, as it was before Orca's launcher, plus its own. */
function serverEnv(server: CommandServer): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of LAUNCHER_ENV) {
    delete env[name]
  }
  if (process.env.ORCA_NODE_OPTIONS) {
    env.NODE_OPTIONS = process.env.ORCA_NODE_OPTIONS
  }
  if (process.env.ORCA_NODE_REPL_EXTERNAL_MODULE) {
    env.NODE_REPL_EXTERNAL_MODULE = process.env.ORCA_NODE_REPL_EXTERNAL_MODULE
  }
  return { ...env, ...server.env }
}

function executablePath(command: string, env: NodeJS.ProcessEnv, cwd: string): string {
  if (/[\\/]/.test(command)) {
    return isAbsolute(command) ? command : resolve(cwd, command)
  }
  const found = resolveCliCommand(command, { pathEnv: env.PATH ?? env.Path ?? null })
  if (!isAbsolute(found)) {
    throw new RuntimeClientError('not_found', `${command} isn’t installed on this computer.`)
  }
  return found
}

/** Runs the server as a child and passes its exit on, for a platform with no execve. */
function runAsWrapper(server: CommandServer, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawnProcess({
      // Node finds `npx` only as `npx.cmd`; the resolved path lets process-host run it through cmd.
      program: executablePath(server.command, env, cwd),
      args: server.args,
      env,
      cwd,
      stdio: 'inherit'
    })
    const stop = (): void => {
      child.kill()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    child.once('error', fail)
    child.once('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0)
      done()
    })
  })
}

/** The command server `flags` name, as this Orca starts it for that agent and workspace. */
async function commandServer({ flags, client, cwd }: HandlerContext): Promise<CommandServer> {
  const id = getRequiredStringFlag(flags, 'id')
  const agent = getRequiredStringFlag(flags, 'agent')
  const workspaceId = await mcpCallerWorkspace(client, cwd, {
    workspace: getOptionalStringFlag(flags, 'workspace'),
    outside: flags.get('outside-workspace') === true
  })
  if (workspaceId === undefined) {
    throw new RuntimeClientError(
      'mcp_server_off',
      'This folder is in more than one workspace, so Orca can’t tell whether the server is on here.'
    )
  }
  const botToken = readInjectedBotToken()
  const callerSessionId = readInjectedAgentSessionId()
  const { result } = await client.call<McpServerConnection>('mcpServers.connect', {
    id,
    agent,
    workspaceId,
    ...(botToken ? { botToken } : {}),
    ...(callerSessionId ? { callerSessionId } : {})
  })
  if (!result.on) {
    throw new RuntimeClientError('mcp_server_off', `This server is off for ${agent} here.`)
  }
  if ('url' in result) {
    throw new RuntimeClientError(
      'invalid_argument',
      'This server is reached by its URL, not started with a command.'
    )
  }
  return { command: result.command, args: result.args, env: result.env }
}

export const MCP_EXEC_HANDLERS: Record<string, CommandHandler> = {
  'mcp exec': async (ctx) => {
    const server = await commandServer(ctx)
    const env = serverEnv(server)
    if (process.platform !== 'win32' && typeof process.execve === 'function') {
      // The agent talks to the server over this process's stdio, which the exec keeps.
      process.execve(
        executablePath(server.command, env, ctx.cwd),
        [server.command, ...server.args],
        env
      )
    }
    await runAsWrapper(server, env, ctx.cwd)
  },
  // For a WSL guest's wrapper (mcp-env-pairs.ts), which reads it from a pipe over interop. The TTY
  // check only keeps a person at a Windows console from printing the values by mistake; it guards
  // nothing (any caller this Orca accepts can read them through mcpServers.connect).
  'mcp env': async (ctx) => {
    if (process.stdout.isTTY) {
      throw new RuntimeClientError(
        'invalid_argument',
        'orca mcp env prints saved values; Orca runs it for a WSL terminal’s server, not a person.'
      )
    }
    const { env } = await commandServer(ctx)
    await new Promise<void>((done, fail) => {
      process.stdout.write(encodeMcpEnvPairs(env), (error) => (error ? fail(error) : done()))
    })
  }
}
