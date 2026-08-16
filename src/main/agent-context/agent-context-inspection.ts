import type { Stats } from 'node:fs'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import type {
  AgentContextHookFile,
  AgentContextInstructionFile,
  AgentContextMcpFile,
  AgentContextPlugin,
  AgentContextReport
} from '../../shared/agent-context'
import { inspectMcpConfigContent, type McpConfigInspection } from '../../shared/mcp-config'
import { inspectCodexMcpToml } from './codex-mcp-toml'
import {
  buildInstructionFileSources,
  type AgentContextPathApi,
  type InstructionFileSource
} from './agent-context-sources'
import {
  buildClaudeSettingsSources,
  buildMcpFileSources,
  type McpFileSource,
  type SettingsFileSource
} from './agent-config-file-sources'

// Why: settings and MCP files are small JSON; anything past this is not config.
const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const RULE_FILE_PATTERN = /\.(md|mdc)$/i

export type AgentContextInspectionArgs = {
  target: AgentContextReport['target']
  /** Maps a display path (as built by the source tables) to the path node fs can open. */
  toAccessPath?: (displayPath: string) => string
  pathApi?: AgentContextPathApi
}

async function statOrNull(pathValue: string): Promise<Stats | null> {
  try {
    return await stat(pathValue)
  } catch {
    return null
  }
}

async function readBoundedText(pathValue: string): Promise<string | null> {
  const fileStat = await statOrNull(pathValue)
  if (!fileStat || !fileStat.isFile()) {
    return null
  }
  if (fileStat.size > MAX_CONFIG_BYTES) {
    return null
  }
  // Why: one unreadable file (EACCES, deleted between stat and open) must not
  // fail the whole report; it reads as missing, like a file that never existed.
  let file: FileHandle
  try {
    file = await open(pathValue, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(fileStat.size)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await file.close().catch(() => undefined)
  }
}

async function countRuleFiles(dirPath: string): Promise<number | null> {
  try {
    // Why: Cursor and Copilot both read rule files from nested folders.
    const entries = await readdir(dirPath, { withFileTypes: true, recursive: true })
    return entries.filter((entry) => entry.isFile() && RULE_FILE_PATTERN.test(entry.name)).length
  } catch {
    return null
  }
}

async function inspectInstructionFile(
  source: InstructionFileSource,
  toAccessPath: (displayPath: string) => string
): Promise<AgentContextInstructionFile> {
  const accessPath = toAccessPath(source.path)
  const base = {
    id: source.id,
    label: source.label,
    path: source.path,
    scope: source.scope,
    agents: [...source.agents]
  }
  if (source.kind === 'directory') {
    const entryCount = await countRuleFiles(accessPath)
    return {
      ...base,
      exists: entryCount !== null,
      sizeBytes: null,
      updatedAt: null,
      entryCount: entryCount ?? undefined
    }
  }
  const fileStat = await statOrNull(accessPath)
  if (!fileStat || !fileStat.isFile()) {
    return { ...base, exists: false, sizeBytes: null, updatedAt: null }
  }
  return { ...base, exists: true, sizeBytes: fileStat.size, updatedAt: fileStat.mtimeMs }
}

/** Merges servers from every configured object path; the first path's inspection carries status. */
function inspectJsonMcpFile(source: McpFileSource, content: string | null): McpConfigInspection {
  const primary = inspectMcpConfigContent(source.candidate, content)
  if (!source.extraServersPaths?.length || primary.status !== 'valid') {
    return primary
  }
  const seen = new Set(primary.servers.map((server) => server.name))
  const servers = [...primary.servers]
  for (const serversPath of source.extraServersPaths) {
    const extra = inspectMcpConfigContent({ ...source.candidate, serversPath }, content)
    for (const server of extra.servers) {
      if (!seen.has(server.name)) {
        seen.add(server.name)
        servers.push(server)
      }
    }
  }
  return { ...primary, servers }
}

async function inspectMcpFile(
  source: McpFileSource,
  toAccessPath: (displayPath: string) => string
): Promise<AgentContextMcpFile> {
  const content = await readBoundedText(toAccessPath(source.path))
  return {
    id: source.id,
    path: source.path,
    scope: source.scope,
    agents: [...source.agents],
    inspection:
      source.format === 'codex-toml'
        ? inspectCodexMcpToml(source.candidate, content)
        : inspectJsonMcpFile(source, content)
  }
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(content)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

/** Claude hooks: `{ [event]: [{ matcher?, hooks: [{type, command}] }] }`. */
export function summarizeClaudeHooks(settings: Record<string, unknown>): {
  events: string[]
  hookCount: number
} {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { events: [], hookCount: 0 }
  }
  const events: string[] = []
  let hookCount = 0
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      continue
    }
    let eventHooks = 0
    for (const group of groups) {
      const entries =
        group && typeof group === 'object' ? (group as { hooks?: unknown }).hooks : undefined
      eventHooks += Array.isArray(entries) ? entries.length : 0
    }
    if (eventHooks > 0) {
      events.push(event)
      hookCount += eventHooks
    }
  }
  return { events, hookCount }
}

export function summarizeClaudeEnabledPlugins(
  settings: Record<string, unknown>
): { name: string; enabled: boolean }[] {
  const enabledPlugins = settings.enabledPlugins
  if (!enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins)) {
    return []
  }
  return Object.entries(enabledPlugins as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'boolean')
    .map(([name, value]) => ({ name, enabled: value === true }))
}

async function inspectClaudeSettings(
  source: SettingsFileSource,
  toAccessPath: (displayPath: string) => string
): Promise<{ hookFile: AgentContextHookFile; plugins: AgentContextPlugin[] }> {
  const base = { id: source.id, path: source.path, scope: source.scope, agents: [...source.agents] }
  const content = await readBoundedText(toAccessPath(source.path))
  if (content === null) {
    return { hookFile: { ...base, exists: false, events: [], hookCount: 0 }, plugins: [] }
  }
  let settings: Record<string, unknown> | null
  try {
    settings = parseJsonObject(content)
  } catch (error) {
    return {
      hookFile: {
        ...base,
        exists: true,
        events: [],
        hookCount: 0,
        error: error instanceof Error ? error.message : 'Invalid JSON'
      },
      plugins: []
    }
  }
  if (!settings) {
    return { hookFile: { ...base, exists: true, events: [], hookCount: 0 }, plugins: [] }
  }
  const { events, hookCount } = summarizeClaudeHooks(settings)
  const plugins = summarizeClaudeEnabledPlugins(settings).map((plugin) => ({
    id: `${source.id}:${plugin.name}`,
    name: plugin.name,
    agents: [...source.agents],
    enabled: plugin.enabled,
    sourcePath: source.path,
    scope: source.scope
  }))
  return { hookFile: { ...base, exists: true, events, hookCount }, plugins }
}

/**
 * Later settings files win for the same plugin (user → project → local), so
 * the panel shows one row per plugin with the deciding file.
 */
export function mergePluginDecisions(plugins: AgentContextPlugin[]): AgentContextPlugin[] {
  const byName = new Map<string, AgentContextPlugin>()
  for (const plugin of plugins) {
    byName.set(plugin.name, plugin)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function inspectAgentContext(
  args: AgentContextInspectionArgs
): Promise<AgentContextReport> {
  const toAccessPath = args.toAccessPath ?? ((displayPath: string) => displayPath)
  const sourceArgs = { homeDir: args.target.homeDir, cwd: args.target.cwd, pathApi: args.pathApi }
  const [instructionFiles, mcpFiles, settings] = await Promise.all([
    Promise.all(
      buildInstructionFileSources(sourceArgs).map((source) =>
        inspectInstructionFile(source, toAccessPath)
      )
    ),
    Promise.all(
      buildMcpFileSources(sourceArgs).map((source) => inspectMcpFile(source, toAccessPath))
    ),
    Promise.all(
      buildClaudeSettingsSources(sourceArgs).map((source) =>
        inspectClaudeSettings(source, toAccessPath)
      )
    )
  ])
  return {
    target: args.target,
    instructionFiles,
    mcpFiles,
    hookFiles: settings.map((entry) => entry.hookFile),
    plugins: mergePluginDecisions(settings.flatMap((entry) => entry.plugins)),
    scannedAt: Date.now()
  }
}
