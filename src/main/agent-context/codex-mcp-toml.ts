import type {
  McpConfigCandidate,
  McpConfigInspection,
  McpServerSummary
} from '../../shared/mcp-config'
import { summarizeMcpServer } from '../../shared/mcp-server-inspection'

// Why: `[mcp_servers.<name>]` tables with a handful of scalar keys are the whole
// surface Codex uses; a full TOML parser is not in the tree, so read exactly that.
const TABLE_HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/
const OTHER_TABLE_HEADER = /^\s*\[\[?[^\]]*\]\]?\s*(?:#.*)?$/
const SCALAR = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/

function parseScalar(raw: string): unknown {
  const trimmed = raw.replace(/\s+#.*$/, '').trim()
  if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed) || /^'[^']*'$/.test(trimmed)) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed === 'true'
  }
  if (/^\[.*\]$/.test(trimmed)) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (/^["'].*["']$/.test(part) ? part.slice(1, -1) : part))
  }
  return trimmed
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
  for (const line of content.split(/\r?\n/)) {
    const header = TABLE_HEADER.exec(line)
    if (header) {
      const name = header[1] ?? header[2] ?? header[3] ?? ''
      current = tables.get(name) ?? {}
      tables.set(name, current)
      continue
    }
    if (OTHER_TABLE_HEADER.test(line)) {
      current = null
      continue
    }
    if (!current) {
      continue
    }
    const scalar = SCALAR.exec(line)
    if (scalar) {
      current[scalar[1]] = parseScalar(scalar[2])
    }
  }
  const servers: McpServerSummary[] = [...tables.entries()].map(([name, entry]) =>
    summarizeMcpServer(name, entry)
  )
  return { candidate, exists: true, status: 'valid', servers }
}
