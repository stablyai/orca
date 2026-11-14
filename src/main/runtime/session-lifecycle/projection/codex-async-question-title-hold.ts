import { agentStatusAuthorityObservedAt } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { CODEX_ASYNC_QUESTION_TOOL } from '../../../../shared/codex-async-question-input'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'

/** Codex's title stays working while its async question waits; only the hook sees the question. */
export function codexAsyncQuestionOutlivesWorkingTitle(
  status: AgentStatusEntry,
  pty: RuntimePtyWorktreeRecord
): boolean {
  return (
    status.state === 'waiting' &&
    status.toolName === CODEX_ASYNC_QUESTION_TOOL &&
    status.interactivePrompt != null &&
    pty.lastAgentStatus === 'working' &&
    agentStatusAuthorityObservedAt(status) > (pty.providerGenerationResetAtEpochMs ?? 0)
  )
}
