// How each terminal agent's CLI takes servers for one run without Orca editing its own config: a
// config file passed by path, `-c` overrides, an inline config variable, or a Pi extension.
// Nothing here puts a saved value or the relay token on the command line.
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  findAgentExecutableIndex,
  isAgentExecutableToken
} from '../../../shared/agent-launch/startup/agent-executable-args'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { MCP_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { readOpenCodeInlineConfig } from '../../opencode/opencode-inline-config'
import { withOpenCodeStandaloneServer } from '../../opencode/opencode-private-server'
import { codexTerminalMcpArgs } from './codex-terminal-mcp-args'
import {
  cliRefusal,
  launchFilePath,
  NOT_PLAIN,
  platformOf,
  shimmed,
  skip,
  withArgs,
  withLiteralToken,
  withTokenReference,
  type TerminalMcpAdapter,
  type TerminalMcpLaunch
} from './terminal-mcp-delivery'
import { WSL_INTEROP_ENV } from './terminal-mcp-wsl-servers'
import { claude, claudeAgentTeams } from './terminal-mcp-claude-adapters'
import { pi } from './terminal-mcp-pi-adapter'

export type {
  TerminalMcpAdapter,
  TerminalMcpDelivery,
  TerminalMcpLaunch
} from './terminal-mcp-delivery'

const copilot: TerminalMcpAdapter = {
  agent: 'copilot',
  executables: ['copilot'],
  wsl: true,
  async deliver(launch, executable) {
    const refused = await cliRefusal(
      launch,
      executable,
      { help: '--additional-mcp-config' },
      'Update GitHub Copilot to use Orca’s servers in its terminal'
    )
    if (refused) {
      return refused
    }
    const platform = platformOf(launch)
    const mcpServers = Object.fromEntries(
      launch.servers.map((given) => {
        const server = shimmed(withLiteralToken(given, launch.token), platform)
        return [
          server.name,
          'url' in server
            ? { type: 'http', url: server.url, headers: server.headers ?? {}, tools: ['*'] }
            : {
                type: 'local',
                command: server.command,
                args: server.args,
                ...(server.env ? { env: server.env } : {}),
                tools: ['*']
              }
        ]
      })
    )
    const path = await launchFilePath(launch, 'copilot', { mcpServers })
    const command =
      path && withArgs(launch, this.executables, ['--additional-mcp-config', `@${path}`])
    return command ? { delivered: true, command, tokenInEnv: false } : skip(NOT_PLAIN)
  }
}

const amp: TerminalMcpAdapter = {
  agent: 'amp',
  executables: ['amp'],
  wsl: true,
  async deliver(launch, executable) {
    const refused = await cliRefusal(
      launch,
      executable,
      { help: '--mcp-config' },
      'Update Amp to use Orca’s servers in its terminal'
    )
    if (refused) {
      return refused
    }
    const platform = platformOf(launch)
    const servers = Object.fromEntries(
      launch.servers.map((given) => {
        const server = shimmed(withLiteralToken(given, launch.token), platform)
        return [
          server.name,
          'url' in server
            ? { url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
            : {
                command: server.command,
                args: server.args,
                ...(server.env ? { env: server.env } : {})
              }
        ]
      })
    )
    const path = await launchFilePath(launch, 'amp', servers)
    const command = path && withArgs(launch, this.executables, ['--mcp-config', path])
    return command ? { delivered: true, command, tokenInEnv: false } : skip(NOT_PLAIN)
  }
}

// `bearer_token_env_var` on a server, first in Codex's MCP client.
const CODEX_BEARER_ENV_VERSION = '0.60.0'
// `env_vars` on a stdio server (openai/codex#5246): Codex starts one with only a fixed list of its
// own variables plus these, so without it a WSL guest's `orca` never gets the interop socket.
const CODEX_ENV_VARS_VERSION = '0.47.0'

/** The WSL servers Codex can start through the guest's `orca`, and the note for an older Codex. */
async function codexWslInterop(
  launch: TerminalMcpLaunch,
  executable: string
): Promise<{ forward: ReadonlySet<string>; dropped: string[]; problem?: string }> {
  const interop = launch.wsl?.interop ?? new Set<string>()
  if (interop.size === 0) {
    return { forward: interop, dropped: [] }
  }
  const tooOld = await cliRefusal(
    launch,
    executable,
    { version: CODEX_ENV_VARS_VERSION },
    `Update Codex in WSL to ${CODEX_ENV_VARS_VERSION} or later to use Orca’s signed-in and saved-value servers there`
  )
  if (!tooOld) {
    return { forward: interop, dropped: [] }
  }
  // Unchecked in time: they still go, and the guest launcher finds the interop socket itself.
  if (tooOld.delivered || !tooOld.agentWide) {
    return { forward: new Set(), dropped: [] }
  }
  return { forward: new Set(), dropped: [...interop], problem: tooOld.reason }
}

const codex: TerminalMcpAdapter = {
  agent: 'codex',
  executables: ['codex'],
  wsl: true,
  async deliver(launch, executable) {
    const relayed = launch.servers.some((server) => 'url' in server && server.headers)
    const refused =
      relayed &&
      (await cliRefusal(
        launch,
        executable,
        { version: CODEX_BEARER_ENV_VERSION },
        'Update Codex to use Orca’s signed-in servers in its terminal'
      ))
    if (refused) {
      return refused
    }
    const { forward, dropped, problem } = await codexWslInterop(launch, executable)
    const { args, skipped } = codexTerminalMcpArgs(
      launch.servers.filter((server) => !dropped.includes(server.name)),
      launch.shell,
      { names: forward, vars: WSL_INTEROP_ENV }
    )
    if (skipped.length + dropped.length > 0) {
      console.warn(
        `[mcp-servers] ${[...dropped, ...skipped].join(', ')} can’t be passed to Codex in this terminal; its session starts without them`
      )
    }
    if (args.length === 0) {
      return skip(problem ?? 'none of its servers can be passed through this shell', !!problem)
    }
    const command = withArgs(launch, this.executables, args)
    return command
      ? { delivered: true, command, tokenInEnv: relayed, ...(problem ? { problem } : {}) }
      : skip(NOT_PLAIN)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const opencode: TerminalMcpAdapter = {
  agent: 'opencode',
  executables: ['opencode'],
  wsl: true,
  async deliver(launch) {
    const given =
      launch.env.OPENCODE_CONFIG_CONTENT ??
      (launch.envToDelete?.includes('OPENCODE_CONFIG_CONTENT')
        ? undefined
        : process.env.OPENCODE_CONFIG_CONTENT)
    const config = readOpenCodeInlineConfig(given)
    const own: unknown = config?.mcp ?? {}
    if (!config || !isRecord(own)) {
      // JSONC or anything else a rewrite would lose: the user's inline config stays as it is.
      return skip('its OPENCODE_CONFIG_CONTENT isn’t plain JSON')
    }
    const ownServers = own
    const platform = platformOf(launch)
    const mcp = Object.fromEntries(
      launch.servers.flatMap((given): [string, unknown][] => {
        if (Object.hasOwn(ownServers, given.name)) {
          return []
        }
        const server = shimmed(withTokenReference(given, `{env:${MCP_TOKEN_ENV}}`), platform)
        return [
          [
            server.name,
            'url' in server
              ? {
                  type: 'remote',
                  url: server.url,
                  ...(server.headers ? { headers: server.headers } : {}),
                  enabled: true
                }
              : {
                  type: 'local',
                  command: [server.command, ...server.args],
                  ...(server.env ? { environment: server.env } : {}),
                  enabled: true
                }
          ]
        ]
      })
    )
    // OpenCode 2 reads its config when its background server starts, so a terminal joining a running
    // one would never see this; a private server of its own does.
    const command =
      launch.env.ORCA_OPENCODE_PLUGIN_API === 'v2'
        ? withOpenCodeStandaloneServer(launch.command, launch.shell)
        : launch.command
    if (launch.env.ORCA_OPENCODE_PLUGIN_API === 'v2' && !/(^|\s)--standalone(\s|$)/.test(command)) {
      return skip('its OpenCode 2 command names a server of its own')
    }
    return {
      delivered: true,
      command,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, mcp: { ...ownServers, ...mcp } })
      },
      tokenInEnv: true
    }
  }
}

const ADAPTERS: Partial<Record<TuiAgent, TerminalMcpAdapter>> = {
  claude,
  'claude-agent-teams': claudeAgentTeams,
  codex,
  copilot,
  amp,
  opencode,
  pi
}

/** The adapter for a launched agent; null for one whose terminal takes no servers from Orca here. */
export function terminalMcpAdapterFor(agent: TuiAgent): TerminalMcpAdapter | null {
  return ADAPTERS[agent] ?? null
}

/** The agent's executable as the launch command names it (for a launcher, the CLI it runs); null
 *  when it doesn't. */
export function terminalMcpExecutable(
  adapter: TerminalMcpAdapter,
  launch: TerminalMcpLaunch
): string | null {
  const parsed = tokenizeStartupCommand(launch.command, launch.shell)
  if (!parsed.ok) {
    return null
  }
  const index = findAgentExecutableIndex(parsed.tokens, launch.shell, (token) =>
    isAgentExecutableToken(token, adapter.executables)
  )
  if (index < 0) {
    return null
  }
  if (adapter.launcher) {
    return parsed.tokens[index + 1] === adapter.launcher.subcommand ? adapter.launcher.runs : null
  }
  return parsed.tokens[index] ?? null
}
