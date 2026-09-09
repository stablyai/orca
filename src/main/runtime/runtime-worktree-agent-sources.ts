import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { collectRuntimeWorktreePtyAgentSources } from './runtime-worktree-pty-agent-sources'
import { structuredRuntimeWorktreeAgentSources } from './runtime-worktree-structured-agent-rows'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

/** One admitted roster for row and worktree-status projection. */
export function collectRuntimeWorktreeAgentSources(
  args: Parameters<typeof collectRuntimeWorktreePtyAgentSources>[0] & {
    structuredSummaries: readonly AgentSessionStatusSummary[]
  }
): ReadonlyMap<string, RuntimeWorktreeAgentSource> {
  const sources = new Map<string, RuntimeWorktreeAgentSource>()
  for (const source of collectRuntimeWorktreePtyAgentSources(args)) {
    sources.set(source.paneKey, source)
  }
  for (const source of structuredRuntimeWorktreeAgentSources(args.structuredSummaries)) {
    if (!sources.has(source.paneKey)) {
      sources.set(source.paneKey, source)
    }
  }
  return sources
}
