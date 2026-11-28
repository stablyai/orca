import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import { MobileNativeChatStructuredAsk } from './MobileNativeChatStructuredAsk'
import {
  formatQuestionAnswerByIndexes,
  formatQuestionAnswerWithOtherByIndexes,
  formatQuestionFreeTextAnswer,
  mobileChatQuestionKey,
  type MobileChatQuestion
} from './mobile-native-chat-question'

/** A chat question on the ask card, whether the host groups it or it was read off the screen. */
export function MobileNativeChatQuestion({
  question,
  onAnswer,
  onCancel,
  onCollapse,
  notice
}: {
  question: MobileChatQuestion
  /** A grouped question's answer is the shared encoding, sent with the prompt it was picked on. */
  onAnswer: (text: string, prompt?: MobileChatQuestion['prompt']) => Promise<boolean>
  onCancel?: (prompt?: NonNullable<MobileChatQuestion['prompt']>) => Promise<boolean>
  // Collapse writes nothing to the agent.
  onCollapse?: () => void
  notice?: string | null
}): React.JSX.Element {
  const cancel = onCancel && (() => onCancel(question.prompt))
  // Picks and step belong to one question: a caller that keeps the card mounted for the next starts fresh.
  const key = mobileChatQuestionKey(question)
  if (question.questions) {
    return (
      <MobileNativeChatStructuredAsk
        key={key}
        questions={question.questions}
        onAnswer={(answers) => onAnswer(answers, question.prompt)}
        onCancel={cancel}
        onCollapse={onCollapse}
        notice={notice}
      />
    )
  }
  return (
    <MobileNativeChatAsk
      key={key}
      prompt={{
        questions: [
          {
            question: question.question,
            multiSelect: question.multiSelect,
            options: question.options.map((label, index) => ({
              label,
              description: question.optionDescriptions?.[index]
            }))
          }
        ]
      }}
      allowOther={[question.allowOther !== false]}
      freeTextInputs={[question.freeTextInput]}
      onAnswer={([selection]) => {
        const picked = selection?.indices ?? []
        const typed = selection?.other
        // A single choice sends its token as is, whatever its label reads.
        const token = question.multiSelect ? null : question.optionTokens[picked[0] ?? -1]
        const text =
          typed === undefined
            ? token || formatQuestionAnswerByIndexes(question, picked)
            : question.multiSelect && picked.length > 0
              ? formatQuestionAnswerWithOtherByIndexes(question, picked, typed)
              : formatQuestionFreeTextAnswer(question, typed)
        return text.length > 0 || question.freeTextInput?.allowEmpty
          ? onAnswer(text)
          : Promise.resolve(false)
      }}
      onCancel={cancel}
      onCollapse={onCollapse}
      notice={notice}
    />
  )
}
