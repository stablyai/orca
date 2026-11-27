// A Codex terminal's servers from the host list as `-c mcp_servers.<name>.*` overrides: dotted keys
// add to the user's servers instead of replacing them, and the relay token is named by its variable
// (`bearer_token_env_var`), so the command line, which lands in shell history, never holds it.
import type { BotToolServer } from '../../../shared/bot-tools'
import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { MCP_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'

/** The relay's header, as a terminal launch's servers name the token (session-mcp-tools.ts). */
export const RELAY_AUTHORIZATION = `Bearer \${${MCP_TOKEN_ENV}}`

// TOML control characters (all but tab), which neither string form may hold raw.
const isControl = (code: number): boolean => (code < 0x20 && code !== 0x09) || code === 0x7f
const hasControl = (value: string): boolean =>
  [...value].some((char) => isControl(char.charCodeAt(0)))

/**
 * `value` as a TOML string: a literal string ('…') when it can be one, since Windows shells mangle
 * the double quotes of a basic string on their way to Codex; null when only a basic string would do
 * and `shell` is one of those.
 */
export function codexTomlString(value: string, shell: AgentStartupShell): string | null {
  if (!value.includes("'") && !hasControl(value)) {
    return `'${value}'`
  }
  if (shell === 'cmd' || shell === 'powershell') {
    return null
  }
  const escaped = [...value]
    .map((char) => {
      const code = char.charCodeAt(0)
      if (char === '\\' || char === '"') {
        return `\\${char}`
      }
      return isControl(code) ? `\\u${code.toString(16).padStart(4, '0')}` : char
    })
    .join('')
  return `"${escaped}"`
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/

/** Variables of Codex's own env each named server is given (`env_vars`): Codex starts a stdio
 *  server with only a fixed list of its own. */
export type CodexForwardedEnv = { names: ReadonlySet<string>; vars: readonly string[] }

function serverOverrides(
  server: BotToolServer,
  shell: AgentStartupShell,
  forward: CodexForwardedEnv | undefined
): string[] | null {
  const key = `mcp_servers.${server.name}`
  const str = (value: string): string | null => codexTomlString(value, shell)
  if ('url' in server) {
    const url = str(server.url)
    const headers = Object.entries(server.headers ?? {})
    // Only the relay's header can be here: a server's saved headers stay with Orca's relay.
    if (
      !url ||
      headers.some(([name, value]) => name !== 'authorization' || value !== RELAY_AUTHORIZATION)
    ) {
      return null
    }
    return [
      `${key}.url=${url}`,
      ...(headers.length > 0 ? [`${key}.bearer_token_env_var='${MCP_TOKEN_ENV}'`] : [])
    ]
  }
  const command = str(server.command)
  const args = server.args.map(str)
  const env = Object.entries(server.env ?? {}).map(([name, value]) => [name, str(value)] as const)
  if (
    !command ||
    args.some((arg) => arg === null) ||
    env.some(([name, value]) => value === null || !TOML_BARE_KEY.test(name))
  ) {
    return null
  }
  const forwarded = forward?.names.has(server.name) ? forward.vars.map(str) : []
  if (forwarded.some((name) => name === null)) {
    return null
  }
  return [
    `${key}.command=${command}`,
    `${key}.args=[${args.join(',')}]`,
    ...(forwarded.length > 0 ? [`${key}.env_vars=[${forwarded.join(',')}]`] : []),
    ...(env.length > 0
      ? [`${key}.env={${env.map(([name, value]) => `${name}=${value}`).join(',')}}`]
      : [])
  ]
}

/** The `-c` args for `servers`, and the names of any whose values `shell` can't carry intact. */
export function codexTerminalMcpArgs(
  servers: readonly BotToolServer[],
  shell: AgentStartupShell,
  forward?: CodexForwardedEnv
): { args: string[]; skipped: string[] } {
  const args: string[] = []
  const skipped: string[] = []
  for (const server of servers) {
    const overrides = serverOverrides(server, shell, forward)
    if (!overrides) {
      skipped.push(server.name)
      continue
    }
    for (const override of overrides) {
      args.push('-c', override)
    }
  }
  return { args, skipped }
}
