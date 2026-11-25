// What the terminal adapters share: the launch they shape servers for, how a CLI's config names the
// relay token, the per-launch config file, and the checks a CLI must pass before its route is used.
import { homedir } from 'node:os'
import type { BotToolServer } from '../../../shared/bot-tools'
import {
  findAgentExecutableIndex,
  isAgentExecutableToken,
  withArgsAfterAgentExecutable
} from '../../../shared/agent-launch/startup/agent-executable-args'
import {
  quoteStartupArg,
  type AgentStartupShell
} from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { cmdShimmedCommand } from '../../bots/bot-tools-claude'
import {
  CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS,
  CLAUDE_MCP_CONFIG_FLAG,
  claudeCliFlagSupport
} from '../../claude/cli-capabilities/claude-cli-flag-support'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import { RELAY_AUTHORIZATION } from './codex-terminal-mcp-args'
import { terminalMcpCliSupports, type TerminalMcpCliRequirement } from './terminal-mcp-cli-support'
import { writeTerminalMcpLaunchFile, wslGuestDrivePath } from './terminal-mcp-launch-files'

/** One terminal launch, with the servers it gets already shaped for a terminal. */
export type TerminalMcpLaunch = {
  /** Relayed ones carry `RELAY_AUTHORIZATION`; command servers with saved env run through `orca mcp exec`. */
  servers: readonly BotToolServer[]
  /** The relay token, when one of `servers` goes through the relay. */
  token: string | null
  command: string
  shell: AgentStartupShell
  /** The spawn's env so far, read only. */
  env: Readonly<Record<string, string>>
  /** What the spawn drops from the env its provider adds (this process's own). */
  envToDelete?: readonly string[]
  cwd: string | undefined
  /** Set when the agent runs in a WSL distro (null: the default one). */
  wsl?: { distro: string | null }
}

export type TerminalMcpDelivery =
  | {
      delivered: true
      command?: string
      /** Set in the spawn's env. */
      env?: Record<string, string>
      /** The CLI reads the token from `ORCA_MCP_TOKEN` in its env. */
      tokenInEnv: boolean
    }
  | {
      delivered: false
      reason: string
      /** True when it holds for every launch of this CLI (too old, refused), not just this one. */
      agentWide: boolean
    }

export const skip = (reason: string, agentWide = false): TerminalMcpDelivery => ({
  delivered: false,
  reason,
  agentWide
})

export const platformOf = (launch: TerminalMcpLaunch): NodeJS.Platform =>
  launch.wsl ? 'linux' : process.platform

/** The server with the relay token written in, for a CLI that reads its config verbatim. */
export function withLiteralToken(server: BotToolServer, token: string | null): BotToolServer {
  if (!('url' in server) || !server.headers || !token) {
    return server
  }
  return {
    ...server,
    headers: Object.fromEntries(
      Object.entries(server.headers).map(([name, value]) => [
        name,
        value === RELAY_AUTHORIZATION ? `Bearer ${token}` : value
      ])
    )
  }
}

/** The relay header in a CLI's own variable syntax. */
export function withTokenReference(server: BotToolServer, reference: string): BotToolServer {
  if (!('url' in server) || !server.headers) {
    return server
  }
  return {
    ...server,
    headers: Object.fromEntries(
      Object.entries(server.headers).map(([name, value]) => [
        name,
        value === RELAY_AUTHORIZATION ? `Bearer ${reference}` : value
      ])
    )
  }
}

export function shimmed(server: BotToolServer, platform: NodeJS.Platform): BotToolServer {
  return 'url' in server ? server : { ...server, ...cmdShimmedCommand(server, platform) }
}

/** A launch file's path as the agent opens it: its guest path in WSL. */
export async function launchFilePath(
  launch: TerminalMcpLaunch,
  agent: string,
  config: unknown
): Promise<string | null> {
  const path = await writeTerminalMcpLaunchFile(agent, config)
  return launch.wsl ? wslGuestDrivePath(launch.wsl.distro, path) : path
}

export function withArgs(
  launch: TerminalMcpLaunch,
  executables: readonly string[],
  args: readonly string[]
): string | null {
  return withArgsAfterAgentExecutable(
    launch.command,
    launch.shell,
    (tokens, shell) =>
      findAgentExecutableIndex(tokens, shell, (token) =>
        isAgentExecutableToken(token, executables)
      ),
    args.map((arg) => ` ${quoteStartupArg(arg, launch.shell)}`).join('')
  )
}

export const NOT_PLAIN = 'its launch command isn’t a plain call of the CLI'

/** The env the CLI will run with: the provider adds this process's own under the spawn's. */
function cliEnv(launch: TerminalMcpLaunch): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return { ...env, ...launch.env }
}

/** A skip unless the CLI meets `requirement`; agent-wide only when it's proven too old. */
export async function cliRefusal(
  launch: TerminalMcpLaunch,
  executable: string,
  requirement: TerminalMcpCliRequirement,
  tooOld: string
): Promise<TerminalMcpDelivery | null> {
  // A WSL distro's CLI can't be asked from here yet, so a route that needs a check isn't used there.
  if (launch.wsl) {
    return skip('its CLI in WSL can’t be checked yet')
  }
  const fact = await terminalMcpCliSupports(executable, requirement, cliEnv(launch), launch.cwd)
  return fact === 'supported'
    ? null
    : fact === 'unsupported'
      ? skip(tooOld, true)
      : skip('its CLI’s options couldn’t be checked in time')
}

/** Whether Claude's organization settings, as a chat or a terminal last learned them, refuse it. */
export async function claudeRefusesMcpConfig(
  launch: TerminalMcpLaunch,
  executable: string
): Promise<boolean> {
  if (launch.wsl) {
    return false
  }
  const env = cliEnv(launch)
  const command = await resolveCommandOnLocalPath(executable, {
    env,
    ...(launch.cwd ? { cwd: launch.cwd } : {})
  }).catch(() => null)
  if (!command) {
    return false
  }
  const fact = await claudeCliFlagSupport.check(
    CLAUDE_MCP_CONFIG_FLAG,
    { command, cwd: launch.cwd ?? homedir(), env },
    CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS,
    false
  )
  return fact === 'unsupported'
}
