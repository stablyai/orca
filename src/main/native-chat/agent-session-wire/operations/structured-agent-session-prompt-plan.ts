import type { AgentSessionPromptResult } from '../../../../shared/agent-session/agent-session-wire'
import { refusingNewerOrcaJournal } from '../../agent-session-journal/replay/journal-open-failure'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import {
  promptAnswerReceipt,
  promptRowAnswer
} from '../../agent-session-journal/writing/command-receipt-prompt-answer'
import {
  performPrompt,
  acceptedPromptAnswer,
  type AgentSessionPromptRequest
} from './structured-agent-session-turns-prompt'

export function promptPlan(
  params: AgentSessionPromptRequest
): MutationPlan<AgentSessionPromptResult> {
  return {
    method: `agentSession.respondTo:${params.kind}`,
    fields: {
      itemId: params.itemId,
      expectedRevision: params.expectedRevision,
      optionId: params.optionId,
      answers: params.answers
    },
    // Retain the resolved or previously recorded prompt answer in the receipt.
    commandReceipt: {
      binding: { at: 'last', kinds: ['item'], answer: 'prompt-answer' },
      result: (row) => promptAnswerReceipt(promptRowAnswer(row)),
      unwritten: (value) => promptAnswerReceipt(value)
    },
    acceptanceRecord: { kind: 'validated-plan' },
    run: (ctx) => refusingNewerOrcaJournal(performPrompt(ctx, params)),
    replay: (_ctx, _outcome, receipt) => acceptedPromptAnswer(receipt)
  }
}
