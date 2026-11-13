import { codexRowAfterQuestionSkip } from '../../../shared/agent-hook-listener/providers/codex-question-skip'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentQuestionAnsweredInferenceRequest } from '../../../shared/agent-status/lifecycle/agent-question-answered-intent'
import { CODEX_ASYNC_QUESTION_TOOL } from '../../../shared/codex-async-question-input'
import { AgentHookServerStatusInference } from './server-status-inference'
import { isValidPaneKey } from './server-status-identity'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** Codex's skip key drops an async question in its TUI and reports nothing, so the renderer
 *  forwards the keystroke as a `codexSkip` question inference for a waiting Codex row. */
export abstract class AgentHookServerCodexQuestionSkip extends AgentHookServerStatusInference {
  override inferQuestionAnswered(request: AgentQuestionAnsweredInferenceRequest): boolean {
    if (!request.codexSkip) {
      return super.inferQuestionAnswered(request)
    }
    if (!isValidPaneKey(request.paneKey)) {
      return false
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the server stores only enriched rows here, as inferQuestionAnswered already assumes.
    const existing = this.state.lastStatusByPaneKey.get(request.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const payload = existing?.payload
    // Codex keeps emitting hooks behind an open question and a skip may follow a skip, so the
    // row's clock is no baseline; the prompt still fences a keystroke from a later turn.
    if (
      !existing ||
      existing.providerSessionOnly ||
      existing.restoredUnconfirmed ||
      payload?.agentType !== 'codex' ||
      payload.toolName !== CODEX_ASYNC_QUESTION_TOOL ||
      payload.state !== 'waiting' ||
      payload.prompt !== request.baselinePrompt ||
      Date.now() - existing.receivedAt > AGENT_STATUS_STALE_AFTER_MS
    ) {
      return false
    }
    const row = codexRowAfterQuestionSkip(this.state, existing)
    return row !== null && this.applyRestatedStatus(row) !== undefined
  }
}
