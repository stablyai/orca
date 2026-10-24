// The MCP servers a chat passes when it creates an agent session. In ACP the host owns MCP
// configuration: an agent that reads its own files already has them, and an agent that does not
// (OMP ignores its on-disk servers in ACP mode by design) has no other way in. A spec that names
// no files passes none and keeps the old `mcpServers: []`.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  isMcpConfigInspectionNameWithinLimit,
  MCP_CONFIG_INSPECTION_MAX_SERVERS
} from '../../shared/mcp-config-inspection-limits'
import type { McpServer } from './generated/acp-protocol.generated'

/** One file an agent's own terminal lane reads. Every MCP document this bridges keeps its servers
 *  under `mcpServers`, the shape the other clients share. */
export type AcpMcpServerFile = {
  path: string
}

/** Why a definition the files carry is not sent. `disabled` covers the document's own denylist and
 *  an entry the agent marked off; `cwd` is a stdio server whose directory ACP cannot express. */
export type AcpMcpServerSkipReason = 'disabled' | 'cwd' | 'unsupported'

export type AcpMcpServerSkip = {
  name: string
  reason: AcpMcpServerSkipReason
}

export type AcpMcpServersRead = {
  servers: McpServer[]
  skipped: AcpMcpServerSkip[]
}

const McpDocumentSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  /** The agent's own denylist, which it ranks above every definition, including an enabled one. */
  disabledServers: z.array(z.string()).optional()
})

const McpServerEntrySchema = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional()
})

/**
 * OMP's own files, in the order its terminal lane reads them: project, the profile this chat pinned,
 * then the portable files other MCP clients share. The first definition of a name wins; files are
 * not merged, which is also what `/mcp list` reports.
 *
 * The profile is read from the launch environment only: a chat that pinned no directory must not
 * inherit whatever profile happens to live under the home directory of whoever reads it.
 */
export function ompMcpServerFiles(input: {
  cwd: string
  env: Readonly<Record<string, string>>
}): AcpMcpServerFile[] {
  const agentDirectory = input.env.PI_CODING_AGENT_DIR?.trim()
  return [
    { path: join(input.cwd, '.omp', 'mcp.json') },
    ...(agentDirectory ? [{ path: join(agentDirectory, 'mcp.json') }] : []),
    { path: join(input.cwd, 'mcp.json') },
    { path: join(input.cwd, '.mcp.json') }
  ]
}

/**
 * Every server the files define, first definition per name winning, minus the ones that must not
 * run. Unreadable and malformed files are skipped: a chat start must not fail because one optional
 * file is broken.
 *
 * A name is reserved by the first file that defines it even when that definition is off, so a
 * lower-priority file cannot re-enable what the higher-priority one disabled.
 */
export async function readAcpMcpServers(
  files: readonly AcpMcpServerFile[],
  env: Readonly<Record<string, string>> = {}
): Promise<AcpMcpServersRead> {
  const definitions = new Map<string, z.infer<typeof McpServerEntrySchema>>()
  const denied = new Set<string>()
  for (const file of files) {
    const content = await readFile(file.path, 'utf8').catch(() => null)
    if (content === null) {
      continue
    }
    const document = parseDocument(content)
    for (const name of document.disabledServers) {
      denied.add(name)
    }
    for (const [name, entry] of document.entries) {
      if (!definitions.has(name)) {
        definitions.set(name, entry)
      }
    }
  }
  return selectServers(definitions, denied, env)
}

/** The ACP form of one MCP document, ignoring the denylist another file might carry. */
export function parseAcpMcpServers(
  content: string,
  env: Readonly<Record<string, string>> = {}
): AcpMcpServersRead {
  const document = parseDocument(content)
  return selectServers(document.entries, new Set(document.disabledServers), env)
}

/** The definitions one document carries, plus the denylist it applies to the whole selection. */
function parseDocument(content: string): {
  entries: Map<string, z.infer<typeof McpServerEntrySchema>>
  disabledServers: readonly string[]
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { entries: new Map(), disabledServers: [] }
  }
  const document = McpDocumentSchema.safeParse(parsed)
  if (!document.success || !document.data.mcpServers) {
    return { entries: new Map(), disabledServers: document.data?.disabledServers ?? [] }
  }
  const entries = new Map<string, z.infer<typeof McpServerEntrySchema>>()
  for (const [name, raw] of Object.entries(document.data.mcpServers)) {
    if (!isMcpConfigInspectionNameWithinLimit(name)) {
      continue
    }
    const entry = McpServerEntrySchema.safeParse(raw)
    if (entry.success) {
      entries.set(name, entry.data)
    }
  }
  return { entries, disabledServers: document.data.disabledServers ?? [] }
}

/** The ACP servers of a merged selection, and why each definition that is not one was dropped. */
function selectServers(
  definitions: ReadonlyMap<string, z.infer<typeof McpServerEntrySchema>>,
  denied: ReadonlySet<string>,
  env: Readonly<Record<string, string>>
): AcpMcpServersRead {
  const servers: McpServer[] = []
  const skipped: AcpMcpServerSkip[] = []
  for (const [name, entry] of definitions) {
    if (servers.length >= MCP_CONFIG_INSPECTION_MAX_SERVERS) {
      break
    }
    if (denied.has(name) || entry.enabled === false) {
      skipped.push({ name, reason: 'disabled' })
      continue
    }
    // ACP's stdio server has no working directory, and starting one there would run it from the
    // agent's instead — a different program than the person configured. A remote server has no
    // process, so its `cwd` (if a document carries one) changes nothing.
    if ((entry.type ?? 'stdio') === 'stdio' && entry.cwd !== undefined) {
      skipped.push({ name, reason: 'cwd' })
      continue
    }
    const server = toAcpServer(name, entry, env)
    if (server) {
      servers.push(server)
    } else {
      skipped.push({ name, reason: 'unsupported' })
    }
  }
  return { servers, skipped }
}

/** One definition in the protocol's shape, or null when it cannot be carried faithfully. */
function toAcpServer(
  name: string,
  entry: z.infer<typeof McpServerEntrySchema>,
  env: Readonly<Record<string, string>>
): McpServer | null {
  const type = entry.type ?? 'stdio'
  if (type === 'http' || type === 'sse') {
    const url = entry.url ? expandEnv(entry.url, env) : ''
    if (!url) {
      return null
    }
    return {
      type,
      name,
      url,
      headers: toNameValuePairs(entry.headers, env)
    }
  }
  if (type !== 'stdio') {
    return null
  }
  const command = entry.command ? expandEnv(entry.command, env) : ''
  if (!command) {
    return null
  }
  return {
    name,
    command,
    args: (entry.args ?? []).map((value) => expandEnv(value, env)),
    env: toNameValuePairs(entry.env, env)
  }
}

/** A document's name/value map as the protocol's pair list, with the environment expanded. */
function toNameValuePairs(
  raw: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string>>
): { name: string; value: string }[] {
  return Object.entries(raw ?? {}).map(([name, value]) => ({
    name,
    value: expandEnv(value, env)
  }))
}

/** `${VAR}` and `${VAR:-default}`, as the agents expand their own files. A name the environment
 *  does not carry expands to nothing rather than the literal placeholder. */
export function expandEnv(value: string, env: Readonly<Record<string, string>>): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name, fallback) => {
      const fromEnv = env[name]
      if (fromEnv !== undefined) {
        return fromEnv
      }
      return typeof fallback === 'string' ? fallback : ''
    }
  )
}
