import {
  formatAgentGenerationFailureOutputForDisplay,
  type AgentGenerationFailureOutput
} from '../text-generation/agent-failure-output'

// Keep full CLI diagnostics local and ephemeral; persist only the sanitized failure badge.
const MAX_ENTRIES = 32
const entriesByWorktreeId = new Map<string, AgentGenerationFailureOutput>()

export function rememberBranchRenameFailureOutput(
  worktreeId: string,
  output: AgentGenerationFailureOutput | null | undefined
): void {
  // Refresh insertion order so eviction removes the least recently updated worktree.
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
