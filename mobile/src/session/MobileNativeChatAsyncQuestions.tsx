import { useContext, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { NativeChatAsyncQuestion } from '../../../src/shared/native-chat-types'
import {
  asyncQuestionsPrompt,
  formatAsyncQuestionAnswer
} from '../../../src/shared/native-chat-async-questions'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import { MobileNativeChatPromptStrip } from './MobileNativeChatPromptStrip'
import { MobileNativeChatAsyncQuestionContext } from './mobile-native-chat-async-question-context'

/** Keeps the answer draft when folded; only an accepted send closes the card automatically. */
export function MobileNativeChatAsyncQuestions({
  questions
}: {
  questions: NativeChatAsyncQuestion[]
}): React.JSX.Element | null {
  const reply = useContext(MobileNativeChatAsyncQuestionContext)
  const [expanded, setExpanded] = useState(true)
  if (!reply || questions.length === 0) {
    return null
  }
  const collapse = (): void => setExpanded(false)
  return (
    <>
      <View style={expanded ? undefined : styles.hidden}>
        <MobileNativeChatAsk
          prompt={asyncQuestionsPrompt(questions)}
          disabled={reply.disabled || !expanded}
          onCollapse={collapse}
          onCancel={async () => {
            collapse()
            return true
          }}
          onAnswer={async (selections) => {
            if (reply.disabled || !expanded) {
              return false
            }
            const text = formatAsyncQuestionAnswer(questions, selections)
            const accepted = !!text && (await reply.send(text))
            if (accepted) {
              collapse()
            }
            return accepted
          }}
        />
      </View>
      {!expanded ? (
        <MobileNativeChatPromptStrip
          title={questions.map((q) => q.title).join(' · ')}
          onExpand={() => setExpanded(true)}
        />
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({ hidden: { display: 'none' } })
