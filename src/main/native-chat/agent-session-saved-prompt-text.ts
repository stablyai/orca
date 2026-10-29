import type {
  AgentJournalRenderItem,
  AgentJournalQuestionItem
} from '../../shared/agent-session-journal-types'
import { agentJournalItemRowOrigin } from '../../shared/agent-session-journal-position'
import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import {
  agentSessionPromptQuestions,
  legacyAgentSessionQuestionAnswers
} from '../../shared/agent-session-question-answer'
import { nativeChatReceiptAnswers } from '../../shared/native-chat-resolution-receipt'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../shared/structured-agent-session-projection'

function questionInterpretation(body: AgentJournalQuestionItem): string[] {
  if (body.resolution.state !== 'resolved') {
    return []
  }
  const selected = body.resolution.selectedOptionId
  const answers =
    body.resolution.answers ?? (selected ? legacyAgentSessionQuestionAnswers(body, selected) : null)
  return agentSessionPromptQuestions(body).flatMap((question) => {
    const heading = `Question ${JSON.stringify(question.id)}${question.header ? ` (${question.header})` : ''}`
    const answer = answers?.find((entry) => entry.questionId === question.id)
    if (!answer || (answer.optionIds.length === 0 && answer.other === undefined)) {
      return [heading, 'Submitted answer: unavailable']
    }
    return [
      heading,
      ...answer.optionIds.map((id) => {
        const option = question.options.find((choice) => choice.id === id)
        return option ? `Selected choice: ${option.label}` : 'Selected choice: unavailable'
      }),
      ...(answer.other !== undefined
        ? [
            body.resolution.answers !== undefined
              ? `Submitted free text: resolution.answers[${body.resolution.answers.indexOf(answer)}].other`
              : `Legacy free text: ${JSON.stringify(answer.other)}`
          ]
        : [])
    ]
  })
}

/** Saved prompts are conversation content even while pending; display projection omits them. */
export function projectSavedChatContextItems(
  items: readonly AgentJournalRenderItem[]
): NativeChatMessage[] {
  return items.flatMap((item): NativeChatMessage[] => {
    const body = item.body
    if (body.kind !== 'question' && body.kind !== 'approval') {
      const message = projectStructuredItemToNativeChat(item)
      return message ? [message] : []
    }
    const interpretation =
      body.kind === 'question'
        ? questionInterpretation(body)
        : body.resolution.state === 'resolved'
          ? [`Selected choice: ${nativeChatReceiptAnswers(body)[0]?.answer ?? 'unavailable'}`]
          : []
    return [
      {
        ...agentJournalItemRowOrigin(item),
        ...agentJournalLinkageFields(item),
        role: 'system',
        blocks: [
          {
            type: 'text',
            text: [
              `Prompt state: ${body.resolution.state}`,
              `Saved prompt: ${JSON.stringify(body)}`,
              ...interpretation
            ].join('\n')
          }
        ]
      }
    ]
  })
}
