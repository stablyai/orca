import type { ProviderRelayKeepSpec } from '../../daemon/protocol/daemon-provider-relay-protocol'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import { readClaudeReportedPermissionMode } from '../structured/startup/claude-structured-init-proof'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { mcpServerSetKey, type McpServerIdentity } from '../../mcp-servers/mcp-server-set-key'
import { settleRelayedReplay } from '../../provider-relay/relayed-provider-replay-settle'

/** Claude's own word on its mode: its init, and the status line it writes for each mode change
 *  (the CLI writes these keys first and in this order). */
const INIT = '{"type":"system","subtype":"init"'
const MODE_REPORT = '{"type":"system","subtype":"status","status":null,"permissionMode":"'

/** The daemon keeps the latest of each, so a reattach knows the mode Claude last confirmed. */
export const CLAUDE_RELAY_KEEP: ProviderRelayKeepSpec = {
  answers: [],
  lines: [INIT, MODE_REPORT],
  outstanding: []
}

/** The note a relay launched with no permission flag carries: Claude runs the user's own settings. */
const OWN_SETTINGS_NOTE = 'own-settings'
/** The note's word for the key of the MCP servers the agent launched with. */
const TOOLS_NOTE = 'tools='

/** The keep spec for a launch's arguments and MCP-set key, noting a launch that left the mode to
 *  Claude's settings, and the servers it was given. */
export function claudeRelayKeepFor(
  args: readonly string[],
  toolsKey?: string
): ProviderRelayKeepSpec {
  const flagged = args.some(
    (arg) =>
      arg === '--dangerously-skip-permissions' ||
      arg === '--permission-mode' ||
      arg.startsWith('--permission-mode=')
  )
  const words = [
    ...(flagged ? [] : [OWN_SETTINGS_NOTE]),
    ...(toolsKey ? [TOOLS_NOTE + toolsKey] : [])
  ]
  return words.length > 0 ? { ...CLAUDE_RELAY_KEEP, note: words.join(' ') } : CLAUDE_RELAY_KEEP
}

const noteWords = (child: RelayedProviderChild): string[] =>
  child.attachResult?.launchNote?.split(' ') ?? []

/** The key of the MCP servers a Claude launch gives its agent (none: 'none'). */
export function claudeLaunchToolsKey(
  servers: Readonly<Record<string, McpServerConfig>> | undefined
): Promise<string> {
  const identities = Object.entries(servers ?? {}).map(([name, config]): McpServerIdentity => ({
    name,
    ...(config.type ? { type: config.type } : {}),
    ...('url' in config ? { url: config.url, headers: config.headers } : {}),
    ...('command' in config ? { command: config.command, args: config.args, env: config.env } : {})
  }))
  return mcpServerSetKey(identities)
}

/** The kept agent launched with other MCP servers than `currentKey` names; one whose note keys
 *  none (an earlier build, or a key that couldn't be made) is unknown, so it is replaced once. */
function claudeKeptToolsOutgrown(child: RelayedProviderChild, currentKey: string): boolean {
  const word = noteWords(child).find((each) => each.startsWith(TOOLS_NOTE))
  return word === undefined || word.slice(TOOLS_NOTE.length) !== currentKey
}

export type ClaudeKeptMode = {
  /** Claude's last reported mode as the daemon kept it, when it kept one. */
  confirmedMode: string | null | undefined
  /** Launched on the user's own settings and still in the mode its init reported from them. */
  ownSettings: boolean
}

/** Hands the kept mode lines to `observe` in the order Claude wrote them, once; a relay spawned
 *  without the keep spec has none, so Claude's mode stays unknown until it reports. */
export function feedClaudeKeptModeLines(
  child: RelayedProviderChild,
  observe: ((chunk: string) => void) | undefined
): ClaudeKeptMode {
  const names = new Set(CLAUDE_RELAY_KEEP.lines.map((marker) => `l:${marker}`))
  const lines = (child.attachResult?.kept ?? [])
    .filter(({ name }) => names.has(name))
    .sort((a, b) => a.seq - b.seq)
    .flatMap(({ seq }) => {
      const line = child.kept.lines.get(seq)
      return line === undefined ? [] : [line]
    })
  child.kept.drop()
  let confirmed: string | null | undefined
  let launched: string | null | undefined
  for (const line of lines) {
    observe?.(`${line}\n`)
    const mode = readKeptMode(line)
    if (mode !== undefined && line.startsWith(INIT)) {
      launched = mode
    }
    confirmed = mode ?? confirmed
  }
  const ownLaunch = noteWords(child).includes(OWN_SETTINGS_NOTE)
  return {
    confirmedMode: confirmed,
    ownSettings: ownLaunch && launched != null && confirmed === launched
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readKeptMode(line: string): string | null | undefined {
  try {
    const frame: unknown = JSON.parse(line)
    return isRecord(frame) ? readClaudeReportedPermissionMode(frame) : undefined
  } catch {
    return undefined
  }
}

/** The answer `StructuredAgentSessionAdapter.keptLaunchOutgrown` gives for a kept agent. */
export type ClaudeKeptLaunchOutgrown = (
  toolsOutdated: boolean,
  owesWork: () => Promise<boolean>
) => Promise<boolean | 'pending' | undefined>

/** See `StructuredAgentSessionAdapter.keptLaunchOutgrown`, for an agent reattached for a launch
 *  with these MCP servers (and app-bound grants it lacks, when `appBound`): a fresh agent is owed
 *  when it lacks either. Only when a refresh could follow, and it owes no work, does it wait
 *  (bounded) for the reattach's replay to be acked; until then an owed one is `pending`. */
export async function claudeKeptLaunchOutgrown(
  child: RelayedProviderChild,
  launch: { mcpServers?: Readonly<Record<string, McpServerConfig>> },
  appBound?: true
): Promise<ClaudeKeptLaunchOutgrown> {
  // A key that can't be made matches no note: a fresh agent is owed.
  const key = await claudeLaunchToolsKey(launch.mcpServers).catch(() => '')
  const owed = appBound === true || claudeKeptToolsOutgrown(child, key)
  return async (toolsOutdated, owesWork) => {
    if (!owed && !toolsOutdated) {
      return child.replayAcked() ? undefined : false
    }
    if (await owesWork()) {
      return false
    }
    await settleRelayedReplay(child)
    if (!child.replayAcked()) {
      return owed ? 'pending' : false
    }
    return owed || undefined
  }
}
