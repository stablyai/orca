import type { McpSyncHostOutcome } from '../../../shared/agent-mcp-sync/mcp-sync-contract'
import { fingerprintMcpValue } from './mcp-sync-ledger'
import { isMcpRecord } from '../../../shared/agent-mcp-sync/mcp-server-portability'

export type ClaudeMcpMergeResult = {
  /** New file text, or null when the file needs no write. */
  text: string | null
  ledger: Record<string, string>
  outcomes: Record<string, McpSyncHostOutcome>
}

/** Merge the desktop's servers into the host's `~/.claude.json` `mcpServers`.
 * An entry is the desktop's only while it still matches what the ledger says was written; anything
 * else under that name is the host user's and is left exactly as is. Every other key is preserved. */
export function mergeClaudeMcpServers(
  text: string | null,
  desired: Readonly<Record<string, Record<string, unknown>>>,
  ledger: Readonly<Record<string, string>>,
  /** Write under `projects[projectPath].mcpServers` (Claude's project scope) instead of user scope. */
  projectPath?: string
): ClaudeMcpMergeResult {
  let root: Record<string, unknown> = {}
  if (text !== null && text.trim()) {
    const parsed: unknown = JSON.parse(text)
    if (!isMcpRecord(parsed)) {
      throw new Error('claude_config_not_object')
    }
    root = parsed
  }
  const projects = isMcpRecord(root.projects) ? root.projects : {}
  const project = projectPath && isMcpRecord(projects[projectPath]) ? projects[projectPath] : {}
  const scope = projectPath ? project.mcpServers : root.mcpServers
  const current = isMcpRecord(scope) ? scope : {}
  const servers: Record<string, unknown> = { ...current }
  const nextLedger: Record<string, string> = {}
  const outcomes: Record<string, McpSyncHostOutcome> = {}
  let changed = false
  const ours = (name: string): boolean =>
    Object.hasOwn(servers, name) &&
    ledger[name] !== undefined &&
    fingerprintMcpValue(servers[name]) === ledger[name]

  for (const name of Object.keys(ledger)) {
    if (!Object.hasOwn(desired, name) && ours(name)) {
      delete servers[name]
      changed = true
    }
  }
  for (const [name, config] of Object.entries(desired)) {
    const print = fingerprintMcpValue(config)
    if (!Object.hasOwn(servers, name)) {
      servers[name] = config
      outcomes[name] = 'added'
      changed = true
    } else if (!ours(name)) {
      outcomes[name] = 'kept-host'
      continue
    } else if (ledger[name] === print) {
      outcomes[name] = 'unchanged'
    } else {
      servers[name] = config
      outcomes[name] = 'updated'
      changed = true
    }
    nextLedger[name] = print
  }
  if (!changed) {
    return { text: null, ledger: nextLedger, outcomes }
  }
  // Claude Code itself writes this file with two-space indentation.
  const next = projectPath
    ? { ...root, projects: { ...projects, [projectPath]: { ...project, mcpServers: servers } } }
    : { ...root, mcpServers: servers }
  return {
    text: `${JSON.stringify(next, null, 2)}\n`,
    ledger: nextLedger,
    outcomes
  }
}
