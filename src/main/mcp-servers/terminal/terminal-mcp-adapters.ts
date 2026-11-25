// How each terminal agent's CLI takes servers for one run without Orca editing its own config: a
// config file passed by path, `-c` overrides, an inline config variable, or a Pi extension.
// Nothing here puts a saved value or the relay token on the command line.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  findAgentExecutableIndex,
  isAgentExecutableToken
} from '../../../shared/agent-launch/startup/agent-executable-args'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { MCP_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { claudeServerConfig } from '../../bots/bot-tools-claude'
import { piMcpServersConfig, piMcpServersExtensionSource } from '../../bots/bot-tools-pi'
import { readOpenCodeInlineConfig } from '../../opencode/opencode-inline-config'
import { withOpenCodeStandaloneServer } from '../../opencode/opencode-private-server'
import {
  getDefaultPiAgentDir,
  ORCA_MANAGED_EXTENSION_MARKER,
  withOrcaManagedExtensionMarker
} from '../../pi/managed-extensions/titlebar-extension-service'
import { writePluginFileAtomically } from '../../plugins/installation/plugin-atomic-file-write'
import { codexTerminalMcpArgs } from './codex-terminal-mcp-args'
import {
  claudeRefusesMcpConfig,
  cliRefusal,
  launchFilePath,
  NOT_PLAIN,
  platformOf,
  shimmed,
  skip,
  withArgs,
  withLiteralToken,
  withTokenReference,
  type TerminalMcpDelivery,
  type TerminalMcpLaunch
} from './terminal-mcp-delivery'

export type { TerminalMcpDelivery, TerminalMcpLaunch } from './terminal-mcp-delivery'

type Adapter = {
  /** The agent the host list's switches name. */
  agent: string
  /** The CLI's executable names, for the launch command's agent token. */
  executables: readonly string[]
  /** It delivers to a WSL distro too (with the servers WSL gets). */
  wsl: boolean
  deliver(launch: TerminalMcpLaunch, executable: string): Promise<TerminalMcpDelivery>
}

const claude: Adapter = {
  agent: 'claude',
  executables: ['claude'],
  wsl: true,
  async deliver(launch, executable) {
    if (await claudeRefusesMcpConfig(launch, executable)) {
      return skip('Claude Code’s organization settings refuse --mcp-config', true)
    }
    const platform = platformOf(launch)
    const mcpServers = Object.fromEntries(
      launch.servers.map((server) => [server.name, claudeServerConfig(server, platform)])
    )
    const path = await launchFilePath(launch, 'claude', { mcpServers })
    // One token: --mcp-config takes every value after it, so a prompt after it would be read as one.
    const command = path && withArgs(launch, this.executables, [`--mcp-config=${path}`])
    return command ? { delivered: true, command, tokenInEnv: true } : skip(NOT_PLAIN)
  }
}

const copilot: Adapter = {
  agent: 'copilot',
  executables: ['copilot'],
  wsl: false,
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

const amp: Adapter = {
  agent: 'amp',
  executables: ['amp'],
  wsl: false,
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

const codex: Adapter = {
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
    const { args, skipped } = codexTerminalMcpArgs(launch.servers, launch.shell)
    if (skipped.length > 0) {
      console.warn(
        `[mcp-servers] ${skipped.join(', ')} can’t be passed to Codex through this terminal’s shell; its session starts without them`
      )
    }
    if (args.length === 0) {
      return skip('none of its servers can be passed through this shell')
    }
    const command = withArgs(launch, this.executables, args)
    return command ? { delivered: true, command, tokenInEnv: relayed } : skip(NOT_PLAIN)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const opencode: Adapter = {
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

export const PI_TERMINAL_MCP_SERVERS_ENV = 'ORCA_PI_MCP_SERVERS'
const PI_TERMINAL_MCP_EXTENSION_FILE = 'orca-mcp-servers.ts'

/** Writes Orca's marked extension into the Pi agent dir; a user's own file of that name stays. */
async function installPiMcpExtension(agentDir: string): Promise<boolean> {
  const dir = join(agentDir, 'extensions')
  const path = join(dir, PI_TERMINAL_MCP_EXTENSION_FILE)
  const source = withOrcaManagedExtensionMarker(
    piMcpServersExtensionSource(PI_TERMINAL_MCP_SERVERS_ENV)
  )
  try {
    const installed = await readFile(path, 'utf8').catch(() => undefined)
    if (installed === source) {
      return true
    }
    if (installed !== undefined && !installed.includes(ORCA_MANAGED_EXTENSION_MARKER)) {
      return false
    }
    await mkdir(dir, { recursive: true })
    await writePluginFileAtomically(path, source)
    return true
  } catch {
    return false
  }
}

/** Pi loads Orca's marked extension from its agent dir; it adds the servers only for a run that sets its variable. */
const pi: Adapter = {
  agent: 'pi',
  executables: ['pi'],
  wsl: false,
  async deliver(launch) {
    const agentDir =
      launch.env.ORCA_PI_SOURCE_AGENT_DIR ??
      launch.env.PI_CODING_AGENT_DIR ??
      process.env.PI_CODING_AGENT_DIR ??
      getDefaultPiAgentDir('pi', undefined)
    const installed = await installPiMcpExtension(agentDir)
    if (!installed) {
      return skip('its extension couldn’t be written to the Pi agent folder')
    }
    const platform = platformOf(launch)
    return {
      delivered: true,
      env: {
        [PI_TERMINAL_MCP_SERVERS_ENV]: piMcpServersConfig(
          launch.servers.map((server) => shimmed(server, platform))
        )
      },
      tokenInEnv: true
    }
  }
}

const ADAPTERS: Partial<Record<TuiAgent, Adapter>> = {
  claude,
  codex,
  copilot,
  amp,
  opencode,
  pi
}

export type TerminalMcpAdapter = Adapter

/** The adapter for a launched agent; null for one whose terminal takes no servers from Orca here. */
export function terminalMcpAdapterFor(agent: TuiAgent): Adapter | null {
  return ADAPTERS[agent] ?? null
}

/** The agent's executable as the launch command names it; null when it doesn't. */
export function terminalMcpExecutable(adapter: Adapter, launch: TerminalMcpLaunch): string | null {
  const parsed = tokenizeStartupCommand(launch.command, launch.shell)
  if (!parsed.ok) {
    return null
  }
  const index = findAgentExecutableIndex(parsed.tokens, launch.shell, (token) =>
    isAgentExecutableToken(token, adapter.executables)
  )
  return index < 0 ? null : (parsed.tokens[index] ?? null)
}
