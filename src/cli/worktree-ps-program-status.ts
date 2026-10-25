import type { RuntimeWorktreeAgentRow } from '../shared/runtime-types'
import {
  programStatusAttentionLabel,
  resolveProgramStatusPresentation
} from '../shared/program-status/presentation'

/** A block takes precedence over progress. */
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
