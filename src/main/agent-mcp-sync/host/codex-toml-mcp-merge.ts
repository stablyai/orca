import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { McpSyncHostOutcome } from '../../../shared/agent-mcp-sync/mcp-sync-contract'
import { isMcpRecord } from '../../../shared/agent-mcp-sync/mcp-server-portability'
import { readMcpServerTomlOwnership } from '../../codex/configuration/toml/config-toml-mcp-servers'
import { fingerprintMcpValue } from './mcp-sync-ledger'

export const CODEX_MCP_BLOCK_START =
  '# >>> Orca: MCP servers synced from your computer. Orca rewrites this block; add your own servers outside it.'
export const CODEX_MCP_BLOCK_END = '# <<< Orca MCP servers'

export type CodexMcpMergeResult = {
  text: string | null
  /** Fingerprint of the block body written (null when no block remains). */
  blockPrint: string | null
  outcomes: Record<string, McpSyncHostOutcome>
}

type Block = { before: string; body: string; after: string }

export type CodexMcpBlockMarkers = { start: string; end: string }

/** One marked block per syncing computer, so two computers syncing one host never rewrite each other's. */
export function codexMcpBlockMarkers(syncer: string | undefined): CodexMcpBlockMarkers {
  return syncer
    ? { start: `${CODEX_MCP_BLOCK_START} [${syncer}]`, end: `${CODEX_MCP_BLOCK_END} [${syncer}]` }
    : { start: CODEX_MCP_BLOCK_START, end: CODEX_MCP_BLOCK_END }
}

function findBlock(text: string, markers: CodexMcpBlockMarkers): Block | null {
  const lines = text.split('\n')
  const start = lines.indexOf(markers.start)
  if (start === -1) {
    return null
  }
  const end = lines.indexOf(markers.end, start + 1)
  if (end === -1) {
    throw new Error('codex_config_block_unterminated')
  }
  return {
    before: lines.slice(0, start).join('\n'),
    body: lines.slice(start + 1, end).join('\n'),
    after: lines.slice(end + 1).join('\n')
  }
}

function blockServers(body: string): Record<string, unknown> {
  const parsed = parseToml(body)
  return isMcpRecord(parsed.mcp_servers) ? parsed.mcp_servers : {}
}

// Blank lines at the seams are normalized so repeated syncs leave the file byte-identical.
function joinParts(parts: string[]): string {
  const text = parts
    .map((part) => part.replace(/^\n+|\n+$/g, ''))
    .filter((part) => part.trim() !== '')
    .join('\n\n')
  return text ? `${text}\n` : ''
}

/** Merge the desktop's servers into the host's Codex `config.toml` inside one marked block.
 * Names configured outside the block are the host user's and win. A block the user edited by hand
 * is unmarked and kept as their own config rather than overwritten. */
export function mergeCodexMcpServers(
  text: string | null,
  desired: Readonly<Record<string, Record<string, unknown>>>,
  lastBlockPrint: string | null,
  markers: CodexMcpBlockMarkers = codexMcpBlockMarkers(undefined),
  /** Markers of a block this computer is taking over (the pre-per-computer block it wrote). */
  adopt?: CodexMcpBlockMarkers
): CodexMcpMergeResult {
  const source = text ?? ''
  // Refuse to edit a file Codex itself could not load.
  parseToml(source)
  const block = findBlock(source, markers) ?? (adopt ? findBlock(source, adopt) : null)
  const handEdited = block !== null && fingerprintMcpValue(block.body) !== lastBlockPrint
  const outside = block
    ? handEdited
      ? joinParts([block.before, block.body, block.after])
      : joinParts([block.before, block.after])
    : source
  const previous = block && !handEdited ? blockServers(block.body) : {}
  const ownership = readMcpServerTomlOwnership(outside)
  const outcomes: Record<string, McpSyncHostOutcome> = {}
  const servers: Record<string, Record<string, unknown>> = {}
  for (const [name, config] of Object.entries(desired)) {
    if (ownership.ownsRoot || ownership.names.has(name)) {
      outcomes[name] = 'kept-host'
      continue
    }
    servers[name] = config
    outcomes[name] = !Object.hasOwn(previous, name)
      ? 'added'
      : fingerprintMcpValue(previous[name]) === fingerprintMcpValue(config)
        ? 'unchanged'
        : 'updated'
  }
  const body =
    Object.keys(servers).length > 0
      ? stringifyToml({ mcp_servers: servers }).replace(/\n+$/, '')
      : null
  if (!block && !body) {
    return { text: null, blockPrint: null, outcomes }
  }
  const blockText = body ? `${markers.start}\n${body}\n${markers.end}` : ''
  const next =
    block && !handEdited
      ? joinParts([block.before, blockText, block.after])
      : joinParts([outside, blockText])
  if (next === source) {
    return { text: null, blockPrint: body ? fingerprintMcpValue(body) : null, outcomes }
  }
  // A config that no longer loads would take every Codex session on the host down with it.
  parseToml(next)
  return { text: next, blockPrint: body ? fingerprintMcpValue(body) : null, outcomes }
}
