// A read-only Codex session (a bot's look-around or tidy-up): no MCP servers, plugins or web search, and every
// approval answered by the host from Orca's allow-list instead of asking a person nobody is watching.
import { isPlainObject } from '../../../agent-hooks/installation/configuration/hooks-json-read'
import {
  codexCommandShells,
  lookAroundShellDecision,
  type ReadOnlySessionMode,
  REPLY_ONLY_REFUSAL
} from '../../../bots/bot-look-around-policy'
import type {
  CodexAppServerConnection,
  CodexAppServerServerRequest
} from '../../app-server/codex-app-server-connection-types'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_MCP_ELICITATION_METHOD,
  CODEX_USER_INPUT_METHOD
} from './codex-prompt-registry'

/** A reply-only run's tools and configured hooks, off for its thread. */
const REPLY_ONLY_FEATURES_OFF = Object.fromEntries(
  [
    'hooks',
    'shell_tool',
    'unified_exec',
    'view_image',
    'image_generation',
    'apps',
    'browser_use',
    'in_app_browser',
    'computer_use',
    'multi_agent',
    'memories'
  ].map((feature) => [`features.${feature}`, false])
)

/** Plugins, web search and, for a reply-only run, every tool off. MCP servers are turned off once
 *  the app-server says which it has (`codexReadOnlyMcpOff`). */
export function codexReadOnlyThreadConfig(
  mode: ReadOnlySessionMode = 'look-around'
): Record<string, unknown> {
  return {
    'features.plugins': false,
    web_search: 'disabled',
    ...(mode === 'reply-only' ? REPLY_ONLY_FEATURES_OFF : {})
  }
}

const MCP_NOT_OFF =
  "Orca couldn't turn off this Codex's MCP servers, so it won't start a read-only run with them."
/** Layers Codex loads over a thread's own config, so a server they turn on stays on. */
const LAYERS_OVER_THREAD = new Set([
  'legacyManagedConfigTomlFromFile',
  'legacyManagedConfigTomlFromMdm'
])
const SERVER_NAME = /^[A-Za-z0-9_-]+$/
const CONFIG_READ_TIMEOUT_MS = 10_000

function layerType(origin: unknown): string | null {
  const name = isPlainObject(origin) ? origin.name : undefined
  return isPlainObject(name) && typeof name.type === 'string' ? name.type : null
}

/**
 * `enabled = false` for every MCP server in the effective config this app-server reads from `cwd`
 * (every layer Codex loads: user, system, managed, every project between cwd and its root, and the
 * launch's `-c` flags): there is no one switch for all of them, and a tool marked read-only would
 * otherwise run without an approval to refuse. Throws when that can't be read, or when a layer over
 * the thread's own config turns a server on, so the run doesn't start.
 */
export async function codexReadOnlyMcpOff(
  connection: Pick<CodexAppServerConnection, 'request'>,
  cwd: string
): Promise<Record<string, false>> {
  let response: unknown
  try {
    response = await connection.request(
      'config/read',
      { cwd },
      { timeoutMs: CONFIG_READ_TIMEOUT_MS }
    )
  } catch {
    throw new Error(MCP_NOT_OFF)
  }
  const config = isPlainObject(response) ? response.config : undefined
  const origins = isPlainObject(response) ? response.origins : undefined
  if (!isPlainObject(config) || !isPlainObject(origins)) {
    throw new Error(MCP_NOT_OFF)
  }
  const servers = config.mcp_servers ?? {}
  if (!isPlainObject(servers)) {
    throw new Error(MCP_NOT_OFF)
  }
  const names = Object.keys(servers)
  if (
    names.some(
      (name) =>
        !SERVER_NAME.test(name) ||
        LAYERS_OVER_THREAD.has(layerType(origins[`mcp_servers.${name}.enabled`]) ?? '')
    )
  ) {
    throw new Error(MCP_NOT_OFF)
  }
  return Object.fromEntries(names.map((name) => [`mcp_servers.${name}.enabled`, false as const]))
}

function requestedCommand(params: unknown): string | null {
  if (typeof params !== 'object' || params === null || !('command' in params)) {
    return null
  }
  // An argv array can't be rejoined faithfully (a space inside one argument would read as two
  // words to the check), so only a command string is judged; anything else is declined.
  return typeof params.command === 'string' ? params.command : null
}

/** The host's answer to a read-only session's request; null when it isn't one to answer here. */
export function codexReadOnlyAnswer(
  request: Pick<CodexAppServerServerRequest, 'method' | 'params'>,
  mode: ReadOnlySessionMode = 'look-around'
): { result: unknown } | { error: string } | null {
  switch (request.method) {
    case CODEX_COMMAND_APPROVAL_METHOD: {
      const command = mode === 'look-around' ? requestedCommand(request.params) : null
      const allowed =
        command !== null &&
        lookAroundShellDecision(command, codexCommandShells()).decision === 'allow'
      return { result: { decision: allowed ? 'accept' : 'decline' } }
    }
    case CODEX_FILE_CHANGE_APPROVAL_METHOD:
      return { result: { decision: 'decline' } }
    case CODEX_MCP_ELICITATION_METHOD:
      return { result: { action: 'decline', content: null, _meta: null } }
    case CODEX_USER_INPUT_METHOD:
      return {
        error:
          mode === 'look-around'
            ? 'Nobody is watching a look-around run to answer.'
            : REPLY_ONLY_REFUSAL
      }
    default:
      return null
  }
}
