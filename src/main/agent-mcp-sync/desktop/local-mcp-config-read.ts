import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { LocalMcpServer } from '../../../shared/agent-mcp-sync/mcp-sync-plan'
import { getSystemCodexHomePath } from '../../codex/configuration/homes/codex-home-paths'
import { isMcpRecord } from '../../../shared/agent-mcp-sync/mcp-server-portability'

// ~/.claude.json also holds chat history per project; refuse anything absurd rather than buffer it.
const MAX_CONFIG_BYTES = 32 * 1024 * 1024

export type LocalMcpConfigPaths = {
  claudeConfig: string
  codexConfig: string
}

export function defaultLocalMcpConfigPaths(
  env: NodeJS.ProcessEnv = process.env
): LocalMcpConfigPaths {
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim()
  return {
    claudeConfig: claudeDir ? join(claudeDir, '.claude.json') : join(homedir(), '.claude.json'),
    codexConfig: join(env.CODEX_HOME?.trim() || getSystemCodexHomePath(), 'config.toml')
  }
}

async function readBounded(path: string): Promise<string | null> {
  try {
    const buffer = await readFile(path)
    return buffer.byteLength > MAX_CONFIG_BYTES ? null : buffer.toString('utf8')
  } catch {
    return null
  }
}

function entries(value: unknown): [string, unknown][] {
  return isMcpRecord(value) ? Object.entries(value) : []
}

function parseJson(text: string | null): unknown {
  if (text === null) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Claude keys projects by the path it was started in; Windows paths may be stored either way.
function projectEntry(projects: unknown, repoPath: string): unknown {
  if (!isMcpRecord(projects)) {
    return undefined
  }
  const wanted = repoPath.replace(/\\/g, '/').replace(/\/+$/, '')
  for (const [path, entry] of Object.entries(projects)) {
    if (path.replace(/\\/g, '/').replace(/\/+$/, '') === wanted) {
      return entry
    }
  }
  return undefined
}

export type LocalMcpConfig = {
  servers: LocalMcpServer[]
  /** Server names in the repo's own `.mcp.json`, which already travels with the checkout. */
  repoServerNames: Set<string>
}

/** Read this computer's Claude Code (user + this repo's local scope) and Codex MCP servers. */
export async function readLocalMcpConfig(
  repoPath: string | null,
  paths: LocalMcpConfigPaths = defaultLocalMcpConfigPaths()
): Promise<LocalMcpConfig> {
  const servers: LocalMcpServer[] = []
  const claude = parseJson(await readBounded(paths.claudeConfig))
  if (isMcpRecord(claude)) {
    for (const [name, config] of entries(claude.mcpServers)) {
      servers.push({ agent: 'claude', name, source: 'claude-user', config })
    }
    const project = repoPath ? projectEntry(claude.projects, repoPath) : undefined
    for (const [name, config] of entries(isMcpRecord(project) ? project.mcpServers : null)) {
      servers.push({ agent: 'claude', name, source: 'claude-project', config })
    }
  }
  const codexText = await readBounded(paths.codexConfig)
  if (codexText !== null) {
    try {
      const codex: unknown = parseToml(codexText)
      for (const [name, config] of entries(isMcpRecord(codex) ? codex.mcp_servers : null)) {
        servers.push({ agent: 'codex', name, source: 'codex', config })
      }
    } catch {
      // An unloadable config has no servers Codex itself would start either.
    }
  }
  const repoMcp = repoPath ? parseJson(await readBounded(join(repoPath, '.mcp.json'))) : null
  const repoServerNames = new Set(
    entries(isMcpRecord(repoMcp) ? repoMcp.mcpServers : null).map(([name]) => name)
  )
  return { servers, repoServerNames }
}
