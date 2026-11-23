// A Claude Code bot's own tools reach its chats as extra MCP config at launch (never written to the
// owner's config: `claude mcp add --scope local` saves under a git repo's root, so a home kept in git
// would hand them to every session). Sign-ins need a configured server, so each bot has a sign-in
// folder of its own, made a git repo so Claude keys it to itself, mirroring the bot's servers; Claude
// keeps a token by server name and URL, so the chats' launch config finds it.
import type { BotLaunchTools } from './bot-launch-tools'
import type { McpHttpServerConfig, McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BOT_TOOL_NAME_PATTERN,
  type BotInheritedTool,
  type BotToolProblem,
  type BotToolServer
} from '../../shared/bot-tools'
import {
  resolveClaudeGlobalConfigFile,
  toClaudeTrustKey
} from '../claude/configuration/claude-folder-trust-file'

const style = process.platform === 'win32' ? 'win32' : 'posix'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return {}
  }
}

/** Claude's global config file for the account whose config dir is `configDir` (null: the default). */
export function claudeAccountConfigFile(configDir: string | null): string {
  return resolveClaudeGlobalConfigFile({
    env: configDir ? { CLAUDE_CONFIG_DIR: configDir } : {},
    homeDir: homedir(),
    style,
    exists: existsSync
  })
}

/** The owner's user servers and enabled plugins, which every one of their Claude sessions loads. */
export async function readClaudeInheritedTools(
  configDir: string | null
): Promise<BotInheritedTool[]> {
  const config = await readJson(claudeAccountConfigFile(configDir))
  const settings = await readJson(join(configDir ?? join(homedir(), '.claude'), 'settings.json'))
  const plugins = Object.entries(record(settings.enabledPlugins)).flatMap(([key, on]) =>
    on === true ? [{ name: key.split('@')[0] ?? key, plugin: true as const }] : []
  )
  const servers = Object.keys(record(config.mcpServers)).map((name) => ({ name }))
  return [...servers, ...plugins]
}

// npm's launchers are .cmd shims on Windows, which Claude Code can only start through cmd.
const WINDOWS_CMD_SHIMS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn'])
const CMD_SPECIAL = /[&|<>^()%]/g

/**
 * An argument for `cmd /c <shim>`: cmd reads an unquoted one twice (its own line, then the shim's
 * %*), so each special character is escaped twice. Node quotes one with a space, and cmd keeps a
 * quoted one as it is, so that is left alone.
 */
export function cmdShimArgument(arg: string): string {
  return arg === '' || /[\s"]/.test(arg) ? arg : arg.replace(CMD_SPECIAL, '^^^$&')
}

/** The servers as Claude's own config writes them. */
export function claudeServerConfig(
  server: BotToolServer,
  platform: NodeJS.Platform = process.platform
): McpHttpServerConfig | McpStdioServerConfig {
  if ('url' in server) {
    return { type: 'http', url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
  }
  const shim = platform === 'win32' && WINDOWS_CMD_SHIMS.has(server.command.toLowerCase())
  return {
    type: 'stdio',
    command: shim ? 'cmd' : server.command,
    args: shim ? ['/c', server.command, ...server.args.map(cmdShimArgument)] : server.args,
    ...(server.env ? { env: server.env } : {})
  }
}

/** The session's own note for the same refusal, so it doesn't claim or try those tools. */
export const CLAUDE_TOOLS_REFUSED_INSTRUCTION =
  "Your own tools (MCP servers) are off in this session: your organization's Claude Code managed settings refuse them. Don't say you have them or try to use them."

/** The bot's servers for a chat's launch, added to the owner's own (never strict). */
export function claudeLaunchServers(
  tools: BotLaunchTools
): Record<string, McpHttpServerConfig | McpStdioServerConfig> {
  return Object.fromEntries(
    tools.servers.map((server) => [server.name, claudeServerConfig(server)])
  )
}

/** The sign-in folder's mirror of each server, by name, as Claude saved it. */
export async function readClaudeMirror(
  configDir: string | null,
  folder: string
): Promise<Record<string, unknown>> {
  const config = await readJson(claudeAccountConfigFile(configDir))
  return record(record(record(config.projects)[toClaudeTrustKey(folder, style)]).mcpServers)
}

const sameConfig = (saved: unknown, server: BotToolServer): boolean => {
  const entry = record(saved)
  const wanted = claudeServerConfig(server)
  const wantedRecord = record(wanted)
  return ['type', 'url', 'headers', 'command', 'args', 'env'].every(
    (key) =>
      JSON.stringify(entry[key] ?? (key === 'type' ? 'stdio' : undefined)) ===
      JSON.stringify(wantedRecord[key])
  )
}

/** Servers the sign-in folder doesn't mirror yet, or mirrors with another config. */
export function claudeMirrorChanges(
  mirror: Record<string, unknown>,
  servers: readonly BotToolServer[]
): BotToolServer[] {
  return servers.filter((server) => !sameConfig(mirror[server.name], server))
}

// JSON, so no flag can swallow the name or an argument.
export const claudeMirrorArgs = (server: BotToolServer): string[] => [
  'mcp',
  'add-json',
  '--scope',
  'local',
  server.name,
  JSON.stringify(claudeServerConfig(server))
]

export const claudeUnmirrorArgs = (name: string): string[] => [
  'mcp',
  'remove',
  '--scope',
  'local',
  name
]

// `claude mcp list` lines: "<name>: <url or command> - <status>".
const LIST_LINE = /^([A-Za-z0-9][A-Za-z0-9_-]*): .* - (.+)$/

/** What `claude mcp list`, run in the sign-in folder, says is wrong with each of `names`. */
export function claudeToolProblems(
  listing: string,
  names: readonly string[]
): Map<string, BotToolProblem> {
  const problems = new Map<string, BotToolProblem>(
    names.map((name) => [name, { kind: 'unconfirmed' }])
  )
  for (const line of listing.split('\n')) {
    const match = LIST_LINE.exec(line.trim())
    const [, name, status] = match ?? []
    if (!name || !status || !names.includes(name) || !BOT_TOOL_NAME_PATTERN.test(name)) {
      continue
    }
    if (/connected/i.test(status) && !/disconnected/i.test(status)) {
      problems.delete(name)
    } else if (/needs auth/i.test(status)) {
      problems.set(name, { kind: 'sign-in' })
    } else if (/fail|error/i.test(status)) {
      problems.set(name, { kind: 'failed', detail: status.replace(/^[^A-Za-z]+/, '') })
    }
  }
  return problems
}

/** A failed CLI run, in its own words. */
export function claudeCliFailure(result: { stdout: string; stderr: string }, what: string): Error {
  const said = (result.stderr.trim() || result.stdout.trim()).split('\n').at(-1)
  return new Error(said ? `${what}: ${said}` : what)
}
