import { isPlanApprovalSubject } from '../../../../shared/agent-session/agent-session-approval-subject'
import type { AgentSessionPromptResult } from '../../../../shared/agent-session/agent-session-wire'
import { refusingNewerOrcaJournal } from '../../agent-session-journal/replay/journal-open-failure'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import {
  performPrompt,
  acceptedPromptAnswer,
  promptAnswerReceipt,
  promptRowAnswer,
  type AgentSessionPromptRequest
} from './structured-agent-session-turns-prompt'

export function promptPlan(
  params: AgentSessionPromptRequest
): MutationPlan<AgentSessionPromptResult> {
  let planChoice: 'default' | 'plan' | undefined
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
      result: (row) => {
        const body = row?.kind === 'item' ? row.body : undefined
        const choice =
          body?.kind === 'approval' &&
          body.resolution.state === 'resolved' &&
          isPlanApprovalSubject(body.subject)
            ? body.resolution.selectedOptionId
            : undefined
        planChoice =
          choice === 'allow' || choice === 'allowForSession'
            ? 'default'
            : choice === 'deny'
              ? 'plan'
              : undefined
        return promptAnswerReceipt(promptRowAnswer(row))
      },
      unwritten: (value) => promptAnswerReceipt(value)
    },
    acceptanceRecord: (record) => {
      if (
        record.provider !== 'claude' ||
        planChoice === undefined ||
        (planChoice === 'default' && record.options?.interactionMode !== 'plan') ||
        record.options?.interactionMode === planChoice
      ) {
        return record
      }
      return { ...record, options: { ...record.options, interactionMode: planChoice } }
    },
    run: (ctx) => refusingNewerOrcaJournal(performPrompt(ctx, params)),
    replay: (_ctx, _outcome, receipt) => acceptedPromptAnswer(receipt)
  }
}
