// What a bot did with the workspaces its owner already has: which ones its reply offers to take over,
// for which area, and whether it moved any under itself unasked. Failures start with "topic:" (it
// misread what the work is) or "offer:" (it offered the wrong thing, or took one unasked).
import type { EvalTurnOutcome } from './bot-orchestration-eval-conversation'
import { writes, type EvalFailure, type TurnCheck } from './bot-orchestration-eval-grading'

type Named = { id: string; name: string }

const OFFER =
  /\btake\b(?:\s+\S+){0,6}?\s+over\b|\bhand(?:ed)?\b(?:\s+\S+){0,4}?\s+(?:to me|over)\b/i

/** The reply's sentences that offer to take something over. */
function offerSentences(turn: EvalTurnOutcome): string[] {
  return turn.reply.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => OFFER.test(sentence))
}

const names = (sentences: string[], entry: Named): boolean =>
  sentences.some((sentence) => new RegExp(`${entry.name}(?![\\w-])`).test(sentence))

/** A workspace moved under the bot on its own, which only the owner's word allows. */
const tookOverUnasked = (turn: EvalTurnOutcome): EvalFailure[] =>
  writes(turn, 'worktree.set').some(
    (write) => write.params.parentWorktree || write.params.crossStoreParent
  )
    ? ['offer: took a workspace over without being handed it']
    : []

/** The reply offers `include` (at least `min` of them) and nothing in `forbid`, and names the topic. */
export function offersArea(input: {
  topic: RegExp
  include: Named[]
  min?: number
  forbid?: Named[]
}): TurnCheck {
  return (turn) => {
    const offered = offerSentences(turn)
    const failures: EvalFailure[] = [...tookOverUnasked(turn)]
    if (!offered.length) {
      return [...failures, 'offer: offered nothing']
    }
    // The offer may list the workspaces on the lines after it.
    const listed = [turn.reply]
    const included = input.include.filter((entry) => names(listed, entry))
    const min = input.min ?? input.include.length
    if (included.length < min) {
      const missing = input.include.filter((entry) => !names(listed, entry))
      failures.push(`offer: left out ${missing.map((entry) => entry.name).join(', ')}`)
    }
    for (const entry of input.forbid ?? []) {
      if (names(offered, entry)) {
        failures.push(`offer: offered ${entry.name}, which it should not`)
      }
    }
    if (!input.topic.test(turn.reply)) {
      failures.push(`topic: the reply never calls it ${input.topic}`)
    }
    return failures
  }
}

/** Nothing offered and nothing taken over. */
export const offersNothing: TurnCheck = (turn) => [
  ...tookOverUnasked(turn),
  ...offerSentences(turn).map((sentence) => `offer: offered "${sentence}" when nothing qualified`)
]

/** Never offers these to itself (another bot's, or another bot's area). */
export function neverOffers(...forbidden: Named[]): TurnCheck {
  return (turn) => [
    ...tookOverUnasked(turn),
    ...forbidden
      .filter((entry) => names(offerSentences(turn), entry))
      .map((entry) => `offer: offered ${entry.name}, which is not its to take`)
  ]
}
