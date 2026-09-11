import { collectRuntimeWorktreePtyAgentSources } from './runtime-worktree-pty-agent-sources'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

/** One admitted roster for row and worktree-status projection. */
export function collectRuntimeWorktreeAgentSources(
  args: Parameters<typeof collectRuntimeWorktreePtyAgentSources>[0]
): ReadonlyMap<string, RuntimeWorktreeAgentSource> {
  const sources = new Map<string, RuntimeWorktreeAgentSource>()
  for (const source of collectRuntimeWorktreePtyAgentSources(args)) {
    sources.set(source.paneKey, source)
  }
  return sources
}
