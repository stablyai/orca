import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { observeAgentStateFile } from '../codex-path-observation'
import { CODEX_BUNDLED_MARKETPLACE_NAMES } from '../homes/codex-home-paths'
import { quoteTomlString } from '../settings/codex-config-path-reference-rewrite'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import {
  normalizeCodexRegistrationValue,
  readCodexRegistrationEntries
} from './config-toml-plugin-registration-tables'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlTableHeaderPath } from './config-toml-key-path'

export const DESKTOP_CUA_REPL_SERVER_NAME = 'cua_repl'
// Header-comment marker: getTomlTableHeader drops trailing comments, so this keeps the header parseable.
export const DESKTOP_CUA_REPL_BROWSER_OFF_MARKER =
  '# orca: browser surface removed (desktop-app only), computer use kept'

const CUA_REPL_PLUGIN_DIRECTORY = 'unified-computer-use'
const CUA_REPL_PLUGIN_REGISTRATION = 'computer-use@openai-bundled'
const CUA_REPL_MCP_FILE = '.mcp.json'
const SURFACES_ENV = 'CUA_REPL_ENABLED_SURFACES'
const BROWSER_SURFACE = 'browser'

type TomlTable = Record<string, unknown>

/**
 * Removes the browser half of the Codex desktop app's `cua_repl` server from a managed home.
 * The desktop-only host context (`BROWSER_USE_ACCESS_*`) exists only in the desktop app's own
 * children, so a mirrored `cua_repl` reports "The browser access host is unavailable" until the
 * agent gives up; with `browser` dropped the runtime answers "Browser APIs are disabled."
 */
export function applyDesktopCuaReplBrowserSurfaceOverride(
  config: string,
  homes: { systemHomePath: string; runtimeHomePath: string }
): string {
  const stripped = stripDesktopCuaReplBrowserSurfaceOverride(config)
  // The desktop plugin names Windows executables; a guest Codex cannot launch them.
  // An unmarked table is someone else's definition and must not be duplicated.
  if (parseWslUncPath(homes.runtimeHomePath) || declaresCuaReplServer(stripped)) {
    return stripped
  }
  const override = readBrowserOffOverride(homes.systemHomePath)
  if (override === null) {
    return stripped
  }
  const body = stripped.replace(/\s+$/, '')
  return body === '' ? `${override}\n` : `${body}\n\n${override}\n`
}

/** Drops every marked `mcp_servers.cua_repl*` table Orca wrote; other bytes are preserved. */
export function stripDesktopCuaReplBrowserSurfaceOverride(config: string): string {
  if (!config.includes(DESKTOP_CUA_REPL_BROWSER_OFF_MARKER)) {
    return config
  }
  const kept: string[] = []
  let dropping = false
  let scan = createTomlLineScanState()
  for (const line of config.split('\n')) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    const header = structural ? getTomlTableHeader(line) : null
    if (header) {
      const isCuaRepl = getMcpServerSectionName(header) === DESKTOP_CUA_REPL_SERVER_NAME
      if (!isCuaRepl) {
        dropping = false
      } else if (line.includes(DESKTOP_CUA_REPL_BROWSER_OFF_MARKER)) {
        dropping = true
      }
    }
    if (!dropping) {
      kept.push(line)
    }
  }
  while (kept.at(-1)?.trim() === '') {
    kept.pop()
  }
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`
}

function getMcpServerSectionName(header: string): string | null {
  const table = parseTomlTableHeaderPath(header)
  return table && !table.isArray && table.segments[0] === 'mcp_servers'
    ? (table.segments[1] ?? null)
    : null
}

function readBrowserOffOverride(systemHomePath: string): string | null {
  const observation = observeAgentStateFile(join(systemHomePath, 'config.toml'))
  if (observation.kind !== 'present') {
    return null
  }
  // A server the user declares themselves wins over any managed override.
  if (declaresCuaReplServer(observation.value)) {
    return null
  }
  if (!isComputerUsePluginEnabled(observation.value)) {
    return null
  }
  const server = findDesktopCuaReplServer(systemHomePath)
  return server === null ? null : renderBrowserOffOverride(server)
}

function declaresCuaReplServer(config: string): boolean {
  let scan = createTomlLineScanState()
  for (const line of config.split('\n')) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    const header = structural ? getTomlTableHeader(line) : null
    if (header && getMcpServerSectionName(header) === DESKTOP_CUA_REPL_SERVER_NAME) {
      return true
    }
  }
  return false
}

function isComputerUsePluginEnabled(config: string): boolean {
  const entry = readCodexRegistrationEntries(config).get(`plugins:${CUA_REPL_PLUGIN_REGISTRATION}`)
  const enabled = entry?.fields.get('enabled')
  // Unregistered plugins never contribute cua_repl, so there is nothing to override.
  return enabled !== undefined && normalizeCodexRegistrationValue(enabled.raw) !== 'false'
}

function findDesktopCuaReplServer(systemHomePath: string): TomlTable | null {
  for (const marketplaceName of CODEX_BUNDLED_MARKETPLACE_NAMES) {
    const pluginRoot = join(
      systemHomePath,
      'plugins',
      'cache',
      marketplaceName,
      CUA_REPL_PLUGIN_DIRECTORY
    )
    const versions = readVersionDirectories(pluginRoot)
    for (const version of versions) {
      const server = readCuaReplServerFromPlugin(join(pluginRoot, version, CUA_REPL_MCP_FILE))
      if (server !== null) {
        return server
      }
    }
  }
  return null
}

function readVersionDirectories(pluginRoot: string): string[] {
  try {
    return readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionsDescending)
  } catch {
    return []
  }
}

function compareVersionsDescending(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

function readCuaReplServerFromPlugin(mcpConfigPath: string): TomlTable | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'))
    const servers = asTable(parsed)?.mcpServers
    const server = asTable(servers)?.[DESKTOP_CUA_REPL_SERVER_NAME]
    return asTable(server)
  } catch {
    return null
  }
}

function asTable(value: unknown): TomlTable | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as TomlTable)
    : null
}

function renderBrowserOffOverride(server: TomlTable): string | null {
  const env = asTable(server.env) ?? {}
  const surfaces = typeof env[SURFACES_ENV] === 'string' ? env[SURFACES_ENV] : ''
  const names = surfaces
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  if (!names.includes(BROWSER_SURFACE)) {
    return null
  }
  // The runtime rejects an empty surface list, so leave the plugin's own definition in charge.
  const remaining = names.filter((name) => name !== BROWSER_SURFACE)
  if (remaining.length === 0) {
    return null
  }
  const lines: string[] = []
  const rendered = emitTomlTable(
    lines,
    `mcp_servers.${DESKTOP_CUA_REPL_SERVER_NAME}`,
    { ...server, env: { ...env, [SURFACES_ENV]: remaining.join(',') } },
    DESKTOP_CUA_REPL_BROWSER_OFF_MARKER
  )
  return rendered ? lines.join('\n') : null
}

/** Codex replaces its plugin entry with a config-table one, so the copy must be complete. */
function emitTomlTable(lines: string[], path: string, table: TomlTable, marker?: string): boolean {
  const entries: string[] = []
  const subtables: [string, TomlTable][] = []
  for (const [key, value] of Object.entries(table)) {
    const subtable = asTable(value)
    if (subtable !== null) {
      subtables.push([key, subtable])
      continue
    }
    const rendered = renderTomlValue(value)
    if (rendered === null) {
      return false
    }
    entries.push(`${formatTomlKey(key)} = ${rendered}`)
  }
  if (marker !== undefined || entries.length > 0) {
    lines.push(`[${path}]${marker === undefined ? '' : ` ${marker}`}`, ...entries)
  }
  for (const [key, subtable] of subtables) {
    if (!emitTomlTable(lines, `${path}.${formatTomlKey(key)}`, subtable)) {
      return false
    }
  }
  return true
}

function renderTomlValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return quoteTomlString(value)
  }
  if (typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (Array.isArray(value)) {
    const items = value.map(renderTomlValue)
    return items.every((item) => item !== null) ? `[${items.join(', ')}]` : null
  }
  return null
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : quoteTomlString(key)
}
