import { createHash } from 'node:crypto'
import { isMcpRecord } from '../../../shared/agent-mcp-sync/mcp-server-portability'

/** What this host last wrote for the desktop, so later syncs can tell their own entries from the user's. */
export type McpSyncLedger = {
  version: 1
  /** Claude server name -> fingerprint of the entry written. */
  claude: Record<string, string>
  /** Fingerprint of the managed Codex block body as last written. */
  codexBlock: string | null
}

export const EMPTY_MCP_SYNC_LEDGER: McpSyncLedger = { version: 1, claude: {}, codexBlock: null }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (isMcpRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    )
  }
  return value
}

/** Key-order-insensitive fingerprint; the ledger stores only this, never the values. */
export function fingerprintMcpValue(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(canonical(value)))
    .digest('hex')
}

export function parseMcpSyncLedger(text: string | null): McpSyncLedger {
  if (!text) {
    return { ...EMPTY_MCP_SYNC_LEDGER, claude: {} }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isMcpRecord(parsed)) {
      return { ...EMPTY_MCP_SYNC_LEDGER, claude: {} }
    }
    const claude: Record<string, string> = {}
    if (isMcpRecord(parsed.claude)) {
      for (const [name, print] of Object.entries(parsed.claude)) {
        if (typeof print === 'string') {
          claude[name] = print
        }
      }
    }
    return {
      version: 1,
      claude,
      codexBlock: typeof parsed.codexBlock === 'string' ? parsed.codexBlock : null
    }
  } catch {
    return { ...EMPTY_MCP_SYNC_LEDGER, claude: {} }
  }
}
