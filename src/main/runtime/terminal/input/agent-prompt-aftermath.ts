import type { RuntimeTerminalAgentStatusState } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RuntimeTerminalPromptDelivery } from '../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import type { AgentPromptActivity } from './agent-prompt-submission-verification'

/** What the terminal showed of a prompt since it went in: read once, when its start is reported. */
export type AgentPromptAftermath =
  | { processReplaced: true }
  | {
      processReplaced: false
      /** A turn began after the prompt's baseline: a lifecycle edge or a new hook turn start. */
      turnStarted: boolean
      permissionSeen: boolean
      /** The agent's own latest status report (hook or program status) and when it arrived. */
      lastReport: AgentStatusReport | null
    }

export type AgentStatusReport = {
  status: NonNullable<RuntimeTerminalAgentStatusState>
  at: number
}

export function readAgentPromptAftermath(
  prompt: RuntimeTerminalPromptDelivery,
  current: AgentPromptActivity,
  lastReport: AgentStatusReport | null
): AgentPromptAftermath {
  if (current.generation !== prompt.generation) {
    return { processReplaced: true }
  }
  return {
    processReplaced: false,
    turnStarted:
      current.workingSequence > prompt.baselineWorkingSequence ||
      (current.explicitWorkingStartedAt !== null &&
        current.explicitWorkingStartedAt > (prompt.baselineExplicitWorkingStartedAt ?? 0)),
    permissionSeen:
      current.status === 'permission' ||
      current.permissionSequence >
        (prompt.baselinePermissionSequence ?? current.permissionSequence),
    lastReport
  }
}
