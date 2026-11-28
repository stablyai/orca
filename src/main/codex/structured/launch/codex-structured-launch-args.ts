import { CODEX_PERMISSION_CONFIG_ROOTS } from '../../../../shared/agent-launch/permissions/agent-permission-args'
import { parse as parseToml } from 'smol-toml'
import { parseTomlKeyPath } from '../../configuration/toml/config-toml-key-path'
import { StructuredAgentArgumentsError } from '../../../native-chat/agent-launch/structured-agent-arguments-error'

const VALUE_OPTIONS = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-m',
  '--model',
  '--local-provider'
])

const DROPPED_VALUE_OPTIONS = new Set([
  '-a',
  '--ask-for-approval',
  '-s',
  '--sandbox',
  '-p',
  '--profile',
  '-C',
  '--cd',
  '--add-dir',
  '-i',
  '--image'
])

const DROPPED_SWITCHES = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--approve-for-me',
  '--not-so-yolo',
  '--dangerously-bypass-hook-trust',
  '--worktree',
  '--strict-config',
  '--help',
  '-h',
  '--version',
  '-V'
])

const PASSTHROUGH_SWITCHES = new Set(['--search', '--oss', '--no-alt-screen', '--no-daemon'])

function optionName(token: string): string {
  if (token.startsWith('--')) {
    return token.split('=', 1)[0]
  }
  if (/^-[acmspiC].+/.test(token)) {
    return token.slice(0, 2)
  }
  return token
}

function inlineValue(token: string, option: string): string | undefined {
  if (token === option) {
    return undefined
  }
  return token.startsWith('--') ? token.slice(option.length + 1) : token.slice(2)
}

function isPermissionConfig(value: string): boolean {
  const key = parseTomlKeyPath(value)?.segments[0]
  return CODEX_PERMISSION_CONFIG_ROOTS.some((root) => root === key)
}

/** Accept only root CLI options; Orca sets permissions on the thread RPC. */
export function codexStructuredLaunchArgs(tokens: readonly string[]): string[] {
  const args: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      break
    }
    const option = optionName(token)
    if (option === '--remote' || option === '--remote-auth-token-env') {
      throw new StructuredAgentArgumentsError('Codex', option, 'unsupportedOption')
    }
    if (DROPPED_SWITCHES.has(option)) {
      continue
    }
    if (PASSTHROUGH_SWITCHES.has(option) && token === option) {
      args.push(token)
      continue
    }
    if (VALUE_OPTIONS.has(option) || DROPPED_VALUE_OPTIONS.has(option)) {
      const value = inlineValue(token, option) ?? tokens[++index]
      if (!value || value === '--' || (value.startsWith('-') && !token.includes('='))) {
        throw new StructuredAgentArgumentsError('Codex', option, 'missingValue')
      }
      if (
        DROPPED_VALUE_OPTIONS.has(option) ||
        (['-c', '--config'].includes(option) && isPermissionConfig(value))
      ) {
        continue
      }
      args.push(token)
      if (token === option) {
        args.push(value)
      }
      continue
    }
    if (!token.startsWith('-')) {
      throw new StructuredAgentArgumentsError('Codex', token, 'positionalPrompt')
    }
    throw new StructuredAgentArgumentsError('Codex', token, 'unsupportedOption')
  }
  return args
}

/**
 * The MCP server names the user's own `-c`/`--config` overrides set (`mcp_servers.<name>.…`, or a
 * whole `mcp_servers={…}` table, which replaces the ones before it), applied in order as Codex
 * does. Codex loads them beside config.toml, so a server from Orca of the same name would merge
 * into one of them.
 */
export function codexArgsMcpServerNames(tokens: readonly string[]): string[] {
  let names = new Set<string>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--') {
      break
    }
    const option = optionName(token)
    if (option !== '-c' && option !== '--config') {
      continue
    }
    // Codex also takes `-c=key=value`.
    const value = (inlineValue(token, option) ?? tokens[++index] ?? '').replace(/^=(?=.*=)/, '')
    const set = configMcpServerNames(value)
    if (set.table) {
      names = new Set()
    }
    for (const name of set.names) {
      names.add(name)
    }
  }
  return [...names]
}

function configMcpServerNames(override: string): { names: string[]; table: boolean } {
  // As Codex reads an override: the key before the first `=`, trimmed, split on `.` with no
  // unquoting, so `"github"` names a server spelled with its quotes.
  const equals = override.indexOf('=')
  if (equals === -1) {
    return { names: [], table: false }
  }
  const segments = override.slice(0, equals).trim().split('.')
  if (segments[0] !== 'mcp_servers') {
    return { names: [], table: false }
  }
  if (segments.length > 1) {
    return { names: [segments[1]!], table: false }
  }
  // `mcp_servers={a={…}}`: the table's own keys name the servers, in place of any before it. Any
  // other value (Codex keeps one that isn't TOML as a string) replaces them with none.
  try {
    const table = parseToml(`mcp_servers = ${override.slice(equals + 1).trim()}`).mcp_servers
    return {
      names:
        typeof table === 'object' && table !== null && !Array.isArray(table)
          ? Object.keys(table)
          : [],
      table: true
    }
  } catch {
    return { names: [], table: true }
  }
}
