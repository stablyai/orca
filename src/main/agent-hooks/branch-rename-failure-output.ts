import {
  formatAgentGenerationFailureOutputForDisplay,
  type AgentGenerationFailureOutput
} from '../text-generation/agent-failure-output'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

// Why: the full CLI output is a diagnostic for the local user only. Keeping it
// in memory (never in worktree metadata) means nothing environment-identifying
// is persisted or synced to paired clients; a restart just loses the on-demand
// view while the sanitized excerpt badge survives.
const MAX_ENTRIES = 32
export const BRANCH_RENAME_FAILURE_KEY_MAX_BYTES = 4 * 1024
export const BRANCH_RENAME_FAILURE_OUTPUT_MAX_BYTES = 520 * 1024
const entriesByWorktreeId = new Map<string, AgentGenerationFailureOutput>()

function fitsByteBudget(values: readonly string[], maxBytes: number): boolean {
  let remainingBytes = maxBytes
  for (const value of values) {
    const measured = measureUtf8ByteLength(value, { stopAfterBytes: remainingBytes })
    if (measured.exceededLimit) {
      return false
    }
    remainingBytes -= measured.byteLength
  }
  return true
}

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
  if (
    !fitsByteBudget([worktreeId], BRANCH_RENAME_FAILURE_KEY_MAX_BYTES) ||
    !fitsByteBudget(
      [output.label, output.stdout, output.stderr],
      BRANCH_RENAME_FAILURE_OUTPUT_MAX_BYTES
    )
  ) {
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

export function __getBranchRenameFailureOutputCountForTests(): number {
  return entriesByWorktreeId.size
}
