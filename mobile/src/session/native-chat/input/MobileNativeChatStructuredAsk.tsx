import type { AgentJournalQuestion } from '../../../../../src/shared/agent-session-journal-types'
import { encodeAgentSessionQuestionAnswers } from '../../../../../src/shared/agent-session-question-answer'
import {
  structuredQuestionAnswers,
  structuredQuestionCard
} from '../../../../../src/shared/structured-agent-question-card'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'

/** Grouped structured prompts use the terminal ask card, as on desktop. */
export function MobileNativeChatStructuredAsk({
  questions,
  onAnswer,
  onCancel
}: {
  questions: readonly AgentJournalQuestion[]
  /** Receives the whole answer set in the shared answer encoding. */
  onAnswer: (encodedAnswers: string) => Promise<boolean>
  onCancel?: () => Promise<boolean>
}): React.JSX.Element {
  return (
    <MobileNativeChatAsk
      {...structuredQuestionCard(questions)}
      onAnswer={async (selections) => {
        const answers = structuredQuestionAnswers(questions, selections)
        return answers ? onAnswer(encodeAgentSessionQuestionAnswers(answers)) : false
      }}
      onCancel={onCancel}
    />
  )
}
