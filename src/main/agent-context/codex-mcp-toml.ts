import type {
  McpConfigCandidate,
  McpConfigInspection,
  McpServerSummary
} from '../../shared/mcp-config'
import { summarizeMcpServer } from '../../shared/mcp-server-inspection'

// Why: `[mcp_servers.<name>]` tables with scalar keys, an args array and an
// optional `env` sub-table are the whole surface Codex uses; a full TOML
// parser is not in the tree, so read exactly that.
const SERVER_TABLE_HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:\.\s*([A-Za-z0-9_.-]+)\s*)?\]\s*(?:#.*)?$/
const ANY_TABLE_HEADER = /^\s*\[\[?[^\]]*\]\]?\s*(?:#.*)?$/
const KEY_VALUE = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*(.+?)\s*$/

function stripComment(raw: string): string {
  let quote: string | null = null
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1
      } else if (char === quote) {
        quote = null
      }
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#') {
      return raw.slice(0, index)
    }
  }
  return raw
}

function unquote(raw: string): string {
  return /^"(?:[^"\\]|\\.)*"$/.test(raw) || /^'[^']*'$/.test(raw) ? raw.slice(1, -1) : raw
}

function parseValue(raw: string): unknown {
  const trimmed = stripComment(raw).trim()
  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed === 'true'
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(unquote)
  }
  return unquote(trimmed)
}

function bracketDepth(raw: string): number {
  const stripped = stripComment(raw)
  let depth = 0
  for (const char of stripped) {
    if (char === '[') {
      depth += 1
    } else if (char === ']') {
      depth -= 1
    }
  }
  return depth
}

/** Servers declared as `[mcp_servers.<name>]` tables in a Codex `config.toml`. */
export function inspectCodexMcpToml(
  candidate: McpConfigCandidate,
  content: string | null
): McpConfigInspection {
  if (content === null) {
    return { candidate, exists: false, status: 'missing', servers: [] }
  }
  const tables = new Map<string, Record<string, unknown>>()
  let current: Record<string, unknown> | null = null
  let pending: { key: string; value: string; depth: number } | null = null
  for (const line of content.split(/\r?\n/)) {
    if (pending) {
      pending.value += ` ${line}`
      pending.depth += bracketDepth(line)
      if (pending.depth <= 0 && current) {
        current[pending.key] = parseValue(pending.value)
        pending = null
      }
      continue
    }
    const header = SERVER_TABLE_HEADER.exec(line)
    if (header) {
      const name = header[1] ?? header[2] ?? header[3] ?? ''
      const server = tables.get(name) ?? {}
      tables.set(name, server)
      // Why: `[mcp_servers.x.env]` is the server's env table; deeper or other
      // sub-tables have no summary meaning, so their keys are skipped.
      if (header[4] === undefined) {
        current = server
      } else if (header[4] === 'env') {
        const env = (server.env as Record<string, unknown> | undefined) ?? {}
        server.env = env
        current = env
      } else {
        current = null
      }
      continue
    }
    if (ANY_TABLE_HEADER.test(line)) {
      current = null
      continue
    }
    if (!current) {
      continue
    }
    const keyValue = KEY_VALUE.exec(line)
    if (!keyValue) {
      continue
    }
    const key = keyValue[1] ?? keyValue[2] ?? keyValue[3] ?? ''
    const rawValue = keyValue[4]
    const depth = bracketDepth(rawValue)
    if (depth > 0) {
      pending = { key, value: rawValue, depth }
      continue
    }
    current[key] = parseValue(rawValue)
  }
  const servers: McpServerSummary[] = [...tables.entries()].map(([name, entry]) =>
    summarizeMcpServer(name, entry)
  )
  return { candidate, exists: true, status: 'valid', servers }
}
