// The desktop's BotItemQuestionLines on the phone: a Needs you comment's question footer, each question
// line with its quick replies. While the item waits on it, the open line reads as a title and its
// recommended reply is filled; the card's Needs you tag carries the color. One question: a quick reply
// posts its words as the owner's comment; Type your answer leads to the box. Several: one line at a
// time (MobileBotItemQuestionStep), answers held until the last. Answered, a line reads
// "Question → answer", muted, and the answer's own card is not drawn again.
import { View, type StyleProp, type ViewStyle } from 'react-native'
import {
  botItemQuickReplyText,
  type BotItemQuestionShape
} from '../../../../src/shared/bots/bot-item-ask'
import {
  botItemAnswersText,
  botItemAnswerWords,
  botItemUnsentAnswers
} from '../../../../src/shared/bots/bot-item-answer-lines'
import type { BotItemEvent } from '../../../../src/shared/bots/bot-items'
import type { BotItemQuickReplyActions } from '../../../../src/shared/bots/use-bot-item-question-steps'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import {
  MobileBotItemAnswerLine,
  MobileBotItemChip,
  MobileBotItemQuestionStep,
  MobileBotItemTypeAnswerChip
} from './MobileBotItemQuestionStep'
import { useBotItemHeldAnswers } from './use-phone-bot-item-question-steps'

const NO_ANSWERS: readonly (BotItemEvent | null)[] = []
const NO_HELD_SCOPE = 'bot-item-answers:none'

export function MobileBotItemQuestionLines({
  shape,
  askId,
  heldScope,
  waiting,
  answers = NO_ANSWERS,
  byOrder,
  actions,
  disabled = false,
  style
}: {
  shape: BotItemQuestionShape
  /** The ask's event id. */
  askId: string
  /** Where this ask's held answers live on this device, for an ask of several questions. */
  heldScope?: string
  /** The item waits on this question now. */
  waiting: boolean
  /** Per line, the owner comment that answered it. */
  answers?: readonly (BotItemEvent | null)[]
  /** Per line, answered only by a comment naming no line: that comment shows as itself. */
  byOrder?: readonly boolean[]
  /** While it waits, what its quick replies do; absent where the item takes no comment. */
  actions?: BotItemQuickReplyActions
  /** The host can't take a comment now (offline). */
  disabled?: boolean
  /** Its spacing from the body above; by default a gap under a body. */
  style?: StyleProp<ViewStyle>
}) {
  const steps = actions?.steps?.askId === askId ? actions.steps : null
  const several = shape.decisions.length > 1
  // Answers held for an ask the agent no longer waits on (it asked again): its draft, until sent.
  const stored = useBotItemHeldAnswers(heldScope ?? NO_HELD_SCOPE, shape)
  const sent = actions?.sent?.askId === askId ? actions.sent.answers : null
  const answered = shape.decisions.map((_, index) => {
    // A line being stepped shows its held answer; with several questions, a comment that named no
    // line shows as itself, not as the line's answer.
    const answer =
      steps?.lines.includes(index) || (several && byOrder?.[index]) ? null : answers[index]
    return answer ? botItemAnswerWords(shape, index, answer.data) : (sent?.[index] ?? null)
  })
  const spacing_ = style ?? (shape.body.trim() ? styles.spaced : null)
  if (waiting && several && steps && actions) {
    return (
      <View style={spacing_}>
        <MobileBotItemQuestionStep
          shape={shape}
          answered={answered}
          steps={steps}
          actions={actions}
          disabled={disabled}
        />
      </View>
    )
  }
  // A line answered meanwhile shows its answer; its held one is not put back in the box.
  const unsentHeld = botItemUnsentAnswers(stored.held, answered)
  const unsent = !waiting && heldScope && unsentHeld.some(Boolean) ? unsentHeld : null
  return (
    <View style={[several ? styles.several : styles.one, spacing_]}>
      {shape.decisions.map((decision, index) => {
        const words = answered[index]
        // Each line waits until its own reply; the agent stops waiting when it asks again or the item closes.
        const open = waiting && !answers[index] && !words
        const held = unsent?.[index]
        if (words) {
          return (
            <MobileBotItemAnswerLine
              key={decision.question}
              question={decision.question}
              words={words}
            />
          )
        }
        if (held && actions && unsent) {
          return (
            <MobileBotItemAnswerLine
              key={decision.question}
              question={decision.question}
              words={held}
              // Not sent: into the box, to send as a comment.
              onPress={() => {
                actions.recover(botItemAnswersText(shape, unsent))
                stored.hold([])
              }}
            />
          )
        }
        return (
          // A decision's question is unique within its ask.
          <View key={decision.question}>
            <MobileMarkdown content={decision.question} tone={open ? 'strong' : 'muted'} />
            {open && actions && decision.replies.length > 0 ? (
              <View style={styles.chips}>
                {decision.replies.map((reply) => (
                  <MobileBotItemChip
                    key={reply.label}
                    reply={reply}
                    filled={reply.recommended === true}
                    disabled={disabled}
                    onPress={() => actions.send(botItemQuickReplyText(shape, decision, reply))}
                  />
                ))}
                <MobileBotItemTypeAnswerChip disabled={disabled} onPress={actions.type} />
              </View>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  spaced: { marginTop: spacing.lg },
  one: { gap: spacing.md },
  several: { gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: 10 }
}))
