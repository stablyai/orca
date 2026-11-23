// The item's waiting ask on the phone, in chat's own question card docked where the comment box is: each
// open question line with its quick replies (hint, Recommended, pick several where the agent asked so),
// Other… for your own words, one line at a time when there are several. Every answer posts as one
// comment, so the agent wakes once. Not now folds it to its line above the comment box.
import { useState } from 'react'
import {
  botItemQuestionLine,
  type BotItemQuestionShape
} from '../../../../src/shared/bots/bot-item-ask'
import { botItemAnswersText } from '../../../../src/shared/bots/bot-item-answer-lines'
import { botItemWaitingAsk } from '../../../../src/shared/bots/bot-item-question-answers'
import type { BotItem, BotItemEvent } from '../../../../src/shared/bots/bot-items'
import type { AskAnswerSelection } from '../../../../src/shared/native-chat/input/questions/native-chat-ask-answer'
import type { AskPrompt } from '../../../../src/shared/native-chat/input/questions/native-chat-ask-types'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { MobileNativeChatAsk } from '../../session/native-chat/input/prompts/MobileNativeChatAsk'
import type { MobileNativeChatCollapsedPrompt } from '../../session/native-chat/input/prompts/MobileNativeChatPromptStrip'

type OpenAsk = {
  askId: string
  shape: BotItemQuestionShape
  open: number[]
}

/** The waiting ask's lines no comment answered yet; the item's own copy of its question stands in until
 *  its event is read. */
function openAsk(item: BotItem, events: readonly BotItemEvent[]): OpenAsk | null {
  const waiting = botItemWaitingAsk(item, events)
  if (waiting) {
    const open = waiting.answers.flatMap((answer, index) => (answer ? [] : [index]))
    return open.length > 0 ? { askId: waiting.askId, shape: waiting.shape, open } : null
  }
  const { question } = item
  const decisions = question?.decisions
  if (
    item.status !== 'needs_you' ||
    !question ||
    !decisions?.length ||
    events.some((event) => event.id === question.eventId)
  ) {
    return null
  }
  return {
    askId: question.eventId,
    shape: { body: '', decisions },
    open: decisions.map((_, index) => index)
  }
}

function askPrompt({ shape, open }: OpenAsk): AskPrompt {
  return {
    questions: open.map((index) => {
      const decision = shape.decisions[index]!
      return {
        question: decision.question,
        multiSelect: decision.multi === true,
        options: decision.replies.map((reply) => ({
          label: reply.label,
          ...(reply.detail ? { description: reply.detail } : {}),
          ...(reply.recommended ? { recommended: true as const } : {})
        }))
      }
    })
  }
}

/** One comment for the card's answers: a line's picks and words as "A, B", each line as a quick reply
 *  of its ask writes it. */
function answerText({ shape, open }: OpenAsk, selections: readonly AskAnswerSelection[]): string {
  const answers = shape.decisions.map((): string | null => null)
  selections.forEach((selection, at) => {
    const index = open[at]!
    const labels = selection.indices.map((pick) => shape.decisions[index]!.replies[pick]!.label)
    const words = [...labels, selection.other?.trim() ?? ''].filter(Boolean).join(', ')
    answers[index] = words || null
  })
  // One question takes the words alone, as the comment box sends them.
  return shape.decisions.length > 1 ? botItemAnswersText(shape, answers) : (answers[0] ?? '')
}

export function useMobileBotItemAskSlot({
  item,
  events,
  online,
  pending,
  send
}: {
  item: BotItem | null
  events: readonly BotItemEvent[]
  online: boolean
  /** An answer is on its way or just landed: the card waits for the item's next event. */
  pending: boolean
  send: (text: string) => Promise<'landed' | 'unknown' | 'failed'>
}): {
  card: React.JSX.Element | null
  /** Folded: the card stays mounted (hidden) so its picks come back on expand. */
  strip: MobileNativeChatCollapsedPrompt | null
} {
  const t = useMobileTranslation()
  const [folded, setFolded] = useState<string | null>(null)
  const ask = item ? openAsk(item, events) : null
  if (!ask) {
    return { card: null, strip: null }
  }
  // One card per ask: a line answered elsewhere leaves it, and the other lines keep their picks.
  const key = ask.askId
  const first = ask.shape.decisions[ask.open[0]!]!
  const fold = (): void => setFolded(key)
  return {
    // Offline it folds too, so the comment box says so; its picks stay for when the host is back.
    strip:
      folded === key || !online
        ? { title: botItemQuestionLine(first.question), expand: () => setFolded(null) }
        : null,
    card: (
      <MobileNativeChatAsk
        key={key}
        prompt={askPrompt(ask)}
        questionKeys={ask.open.map(String)}
        answerPending={pending || !online}
        onAnswer={async (selections) => {
          const text = answerText(ask, selections)
          if (!text) {
            return false
          }
          const outcome = await send(text)
          if (outcome !== 'landed') {
            // The comment box under it says why.
            fold()
          }
          return outcome !== 'failed'
        }}
        onCancel={async () => {
          fold()
          return true
        }}
        cancelLabel={t('bots.items.ask.notNow', 'Not now')}
        onCollapse={fold}
      />
    )
  }
}
