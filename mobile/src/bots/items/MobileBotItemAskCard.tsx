// The item's waiting ask in chat's own answer card, docked where the comment box is: each open question
// with its options (detail, Recommended, pick several where the agent asked so), Other… for your own
// words, one question at a time when there are several. The answers post as one comment naming the ask,
// so the agent wakes once; lines left unanswered close as skipped. Not now folds it to the chat's strip.
import { useContext, useEffect, useRef, useState } from 'react'
import { Keyboard } from 'react-native'
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
import { BotItemCommentMicContext } from './bot-item-comment-mic'
import {
  readBotItemAskCardDraft,
  retireBotItemAskCardDraft,
  saveBotItemAskCardDraft
} from './bot-item-ask-card-drafts'

type OpenAsk = { askId: string; shape: BotItemQuestionShape; open: number[] }

/** The waiting ask's lines no comment answered yet; the item's own copy of its question stands in until
 *  its event is read. */
export function botItemOpenAsk(item: BotItem, events: readonly BotItemEvent[]): OpenAsk | null {
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

/** One comment for the card's answers, each line as a quick reply of its ask writes it, and the open
 *  lines it leaves unanswered. */
function answerOf(
  { shape, open }: OpenAsk,
  selections: readonly AskAnswerSelection[]
): { text: string; skipped: number[] } {
  const answers = shape.decisions.map((): string | null => null)
  selections.forEach((selection, at) => {
    const index = open[at]!
    const labels = selection.indices.map((pick) => shape.decisions[index]!.replies[pick]!.label)
    const words = [...labels, selection.other?.trim() ?? ''].filter(Boolean).join(', ')
    answers[index] = words || null
  })
  return {
    // One question takes the words alone, as a quick reply sends them.
    text: shape.decisions.length > 1 ? botItemAnswersText(shape, answers) : (answers[0] ?? ''),
    skipped: open.filter((index) => !answers[index])
  }
}

export function useMobileBotItemAskSlot({
  itemKey,
  ask,
  online,
  replying,
  loaded,
  host,
  onOpenWithCard,
  send
}: {
  /** The item on its host, whose card keeps its unsent picks and words when the page closes. */
  itemKey: string
  /** Null while nothing waits. */
  ask: OpenAsk | null
  online: boolean
  /** A reply is on its way: the card stays mounted under the box, so a reply that fails or answers
   *  nothing gives its picks back. */
  replying: boolean
  /** The item is read, so the page has opened. */
  loaded: boolean
  /** The host's read of the ask the agent waits on and whether the item closed; null until read. */
  host: { askId: string | null; closed: boolean } | null
  /** The page opened with the card up: it starts at its title, not at the end of Activity. */
  onOpenWithCard: () => void
  send: (text: string, answering: { askId: string; skipped: readonly number[] }) => void
}): {
  card: React.JSX.Element | null
  /** The card or its strip stands for the question. */
  askOpen: boolean
  /** The card shows in the comment box's place. */
  askShown: boolean
  /** Not now, offline or dictating: the strip shows in the card's place, which stays mounted. */
  strip: MobileNativeChatCollapsedPrompt | null
  /** Folds the card to its strip, as Not now does. */
  fold: () => void
} {
  const t = useMobileTranslation()
  const [folded, setFolded] = useState<string | null>(null)
  // As chat's card, it waits while dictation runs or lands in the box.
  const mic = useContext(BotItemCommentMicContext)
  const key = ask?.askId ?? null
  const askOpen = ask !== null && !replying
  const askShown = askOpen && folded !== key && online && !mic?.micActive && !mic?.micProcessing
  const opened = useRef(false)
  useEffect(() => {
    if (!opened.current && loaded) {
      opened.current = true
      if (askShown) {
        onOpenWithCard()
      }
    }
  }, [loaded, askShown, onOpenWithCard])
  useEffect(() => {
    // The card takes the comment box's place: a keyboard up for the box would type into it unseen.
    if (askShown) {
      Keyboard.dismiss()
    }
  }, [askShown])
  const hostAskId = host?.askId ?? null
  const hostRead = host !== null
  const closed = host?.closed === true
  useEffect(() => {
    // The host's read decides: a card kept for a replaced ask, or on a closed item, goes; the open
    // ask's stays across Back, offline, Not now, a failed Send and history still loading.
    if (hostRead) {
      retireBotItemAskCardDraft(itemKey, { askId: hostAskId, closed })
    }
  }, [hostRead, itemKey, hostAskId, closed])
  const fold = (): void => setFolded(key)
  if (!ask) {
    return { card: null, askOpen, askShown, strip: null, fold }
  }
  const first = ask.shape.decisions[ask.open[0]!]!
  return {
    askOpen,
    askShown,
    fold,
    strip:
      askOpen && !askShown
        ? { title: botItemQuestionLine(first.question), expand: () => setFolded(null) }
        : null,
    // One card per ask: a line answered elsewhere leaves it, and the other lines keep their picks.
    // Offline it folds, so the comment box says why; its picks stay for when the host is back.
    card: (
      <MobileNativeChatAsk
        key={ask.askId}
        prompt={askPrompt(ask)}
        questionKeys={ask.open.map(String)}
        drafts={{
          saved: readBotItemAskCardDraft(itemKey, ask.askId),
          onChange: (questions) => saveBotItemAskCardDraft(itemKey, ask.askId, questions)
        }}
        answerPending={!online}
        onAnswer={async (selections) => {
          const { text, skipped } = answerOf(ask, selections)
          if (!text) {
            return false
          }
          send(text, { askId: ask.askId, skipped })
          return true
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
