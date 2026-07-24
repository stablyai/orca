import {
  formatAgentGenerationFailureOutputForDisplay,
  type AgentGenerationFailureOutput
} from '../text-generation/agent-failure-output'

// Why: the full CLI output is a diagnostic for the local user only. Keeping it
// in memory (never in worktree metadata) means nothing environment-identifying
// is persisted or synced to paired clients; a restart just loses the on-demand
// view while the sanitized excerpt badge survives.
const MAX_ENTRIES = 32
const entriesByWorktreeId = new Map<string, AgentGenerationFailureOutput>()

export function rememberBranchRenameFailureOutput(
  worktreeId: string,
  output: AgentGenerationFailureOutput | null | undefined
): void {
  // Delete-then-set keeps insertion order as recency so eviction drops the
  // stalest worktree first.
  entriesByWorktreeId.delete(worktreeId)
  if (!output) {
    return
  }
  entriesByWorktreeId.set(worktreeId, output)
  while (entriesByWorktreeId.size > MAX_ENTRIES) {
    const oldest = entriesByWorktreeId.keys().next().value
    if (oldest === undefined) {
      break
    }
    entriesByWorktreeId.delete(oldest)
  }
}

export function readBranchRenameFailureOutputForDisplay(worktreeId: string): string | null {
  const entry = entriesByWorktreeId.get(worktreeId)
  return entry ? formatAgentGenerationFailureOutputForDisplay(entry) : null
}

export function __resetBranchRenameFailureOutputForTests(): void {
  entriesByWorktreeId.clear()
}
