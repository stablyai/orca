import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../../../src/shared/agent-session-journal-types'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import { MobileStructuredQuestionGroupCard } from './MobileStructuredQuestionGroupCard'

export type MobileStructuredPromptItem = AgentJournalRenderItem & {
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
}

function encodeQuestionOption(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

export function MobileStructuredPromptCard(props: {
  item: MobileStructuredPromptItem
  onRespond: (item: MobileStructuredPromptItem, optionId: string) => Promise<boolean>
}): React.JSX.Element {
  const { item } = props
  if (item.body.kind === 'approval') {
    return (
      <MobileNativeChatPermission
        permission={{
          title: item.body.title,
          detail: item.body.detail ?? undefined,
          options: item.body.options.map((option) => ({
            label: option.label,
            send: option.id
          }))
        }}
        onRespond={(optionId) => props.onRespond(item, optionId)}
      />
    )
  }
  const questionBody = item.body as AgentJournalQuestionItem
  if (questionBody.questions) {
    return (
      <MobileStructuredQuestionGroupCard
        key={`${item.itemId}:${item.revision}`}
        questions={questionBody.questions}
        onAnswer={(optionId) => props.onRespond(item, optionId)}
      />
    )
  }
  const question = {
    question: questionBody.question,
    options: questionBody.options.map((option) => option.label),
    multiSelect: false,
    optionTokens: questionBody.options.map(() => null)
  }
  return (
    <MobileNativeChatQuestion
      question={question}
      allowFreeText={Boolean(questionBody.freeTextQuestionId)}
      onAnswer={(answer) => {
        const offered = questionBody.options.find((option) => option.label === answer)
        const optionId =
          offered?.id ??
          (questionBody.freeTextQuestionId
            ? encodeQuestionOption(questionBody.freeTextQuestionId, answer)
            : '')
        return optionId ? props.onRespond(item, optionId) : Promise.resolve(false)
      }}
    />
  )
}
