import type { RuntimeWorktreeAgentRow } from '../shared/runtime-types'
import {
  programStatusAttentionLabel,
  resolveProgramStatusPresentation
} from '../shared/program-status/presentation'

/** Compact OSC 7501 suffix for a `worktree ps` line: a block beats progress; '' when neither. */
export function formatWorktreePsProgramStatus(
  agents: readonly RuntimeWorktreeAgentRow[] | undefined
): string {
  let progress: number | undefined
  for (const agent of agents ?? []) {
    const presentation = resolveProgramStatusPresentation({
      state: agent.state,
      programStatus: agent.programStatus,
      toolName: agent.toolName ?? undefined
    })
    if (presentation.attention) {
      return `  (${programStatusAttentionLabel(presentation.attention)})`
    }
    progress ??= presentation.progress
  }
  return progress === undefined ? '' : `  ${progress}%`
}
