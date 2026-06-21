// Why: lets the renderer manage jcode's MCP servers ("connectors") from the GUI.
// jcode reads stdio MCP servers from ~/.jcode/mcp.json (Claude-Desktop format)
// and exposes their tools to the agent automatically — so the only work here is
// a safe read/write bridge for that one global file. We deliberately manage ONLY
// the global file; jcode still merges project-local (.jcode/mcp.json) and the
// .claude/mcp.json compat file on its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ipcMain } from 'electron'
import {
  JCODE_MCP_GET_CHANNEL,
  JCODE_MCP_SET_CHANNEL,
  type JcodeMcpActionResult,
  type JcodeMcpConfigResult,
  type JcodeMcpServer,
  type JcodeMcpSetArgs
} from '../../shared/jcode-chat-types'

const NAME_RE = /^[a-zA-Z0-9_.-]+$/

function mcpJsonPath(): string {
  return join(homedir(), '.jcode', 'mcp.json')
}

/** On-disk shape jcode expects. */
type OnDiskServer = {
  command: string
  args?: string[]
  env?: Record<string, string>
  shared?: boolean
}
type OnDiskConfig = { servers?: Record<string, OnDiskServer> }

function readConfig(): { servers: JcodeMcpServer[] } {
  const path = mcpJsonPath()
  if (!existsSync(path)) {
    return { servers: [] }
  }
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as OnDiskConfig
  const servers: JcodeMcpServer[] = Object.entries(parsed.servers ?? {}).map(([name, value]) => ({
    name,
    command: typeof value.command === 'string' ? value.command : '',
    args: Array.isArray(value.args) ? value.args.filter((a) => typeof a === 'string') : [],
    env:
      value.env && typeof value.env === 'object'
        ? Object.fromEntries(
            Object.entries(value.env).filter(([, v]) => typeof v === 'string') as [string, string][]
          )
        : {},
    shared: value.shared !== false
  }))
  // Stable order for the UI.
  servers.sort((a, b) => a.name.localeCompare(b.name))
  return { servers }
}

function getMcpConfig(): JcodeMcpConfigResult {
  try {
    const { servers } = readConfig()
    return { ok: true, servers, path: mcpJsonPath() }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      servers: [],
      path: mcpJsonPath()
    }
  }
}

function validateServers(servers: JcodeMcpServer[]): string | null {
  if (!Array.isArray(servers)) {
    return 'Invalid request.'
  }
  const seen = new Set<string>()
  for (const server of servers) {
    const name = server?.name?.trim()
    if (!name || !NAME_RE.test(name)) {
      return `Server name "${name ?? ''}" is invalid (letters, numbers, ".", "-", "_" only).`
    }
    if (seen.has(name)) {
      return `Duplicate server name "${name}".`
    }
    seen.add(name)
    if (!server.command?.trim()) {
      return `Server "${name}" needs a command.`
    }
    if (server.args && !Array.isArray(server.args)) {
      return `Server "${name}" args must be a list.`
    }
  }
  return null
}

function setMcpConfig(args: JcodeMcpSetArgs): JcodeMcpActionResult {
  const servers = args?.servers
  const validationError = validateServers(servers)
  if (validationError) {
    return { ok: false, error: validationError }
  }
  try {
    const path = mcpJsonPath()
    const dir = dirname(path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    // Keep a single-level backup before overwriting user data.
    if (existsSync(path)) {
      try {
        copyFileSync(path, `${path}.bak`)
      } catch {
        // Non-fatal: proceed without a backup rather than block the save.
      }
    }
    const onDisk: OnDiskConfig = { servers: {} }
    for (const server of servers) {
      onDisk.servers![server.name.trim()] = {
        command: server.command.trim(),
        args: (server.args ?? []).map((a) => a).filter((a) => a.length > 0),
        env: server.env ?? {},
        shared: server.shared !== false
      }
    }
    writeFileSync(path, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerJcodeMcpHandlers(): void {
  ipcMain.removeHandler(JCODE_MCP_GET_CHANNEL)
  ipcMain.handle(JCODE_MCP_GET_CHANNEL, () => getMcpConfig())

  ipcMain.removeHandler(JCODE_MCP_SET_CHANNEL)
  ipcMain.handle(JCODE_MCP_SET_CHANNEL, (_event, raw: unknown) =>
    setMcpConfig(raw as JcodeMcpSetArgs)
  )
}
