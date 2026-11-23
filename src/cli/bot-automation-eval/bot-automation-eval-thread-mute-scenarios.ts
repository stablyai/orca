// A person in a Slack thread asks the bot, in other words, to stop listening there: the bot tells
// them the exact message to send, never claims it stopped, and never tries to do it itself.
import type { EvalOutcome } from './bot-automation-eval-host'
import type { EvalScenario } from './bot-automation-eval-grading'

const SLACK_THREAD = { source: 'slack' as const, title: 'deploy review' }
const PHRASE = /stop listening to this thread/i
// "I've muted…", "I'll stop replying here", "Done, I won't respond": a claim that it took effect.
const CLAIM =
  /\b(?:i(?:'ve| have) (?:muted|stopped|unfollowed|turned off)|i(?:'m| am) (?:now )?(?:muted|no longer|not going to (?:reply|respond))|i(?:'ll| will) (?:stop|no longer) (?:listening|replying|responding|following)|i won't (?:reply|respond))/i

/** What reached the thread: the final message and any `bot reply` text. */
function texts(outcome: EvalOutcome): string[] {
  return [
    outcome.reply,
    ...outcome.writes.flatMap((write) => {
      const args = write.params.args
      const text =
        write.params.text ??
        (typeof args === 'object' && args !== null && 'text' in args ? args.text : undefined)
      return write.method === 'connector.reply' && typeof text === 'string' ? [text] : []
    })
  ]
}

function gradeRedirect(outcome: EvalOutcome): string[] {
  const visible = texts(outcome).join('\n')
  const reacted = outcome.writes.some((write) => JSON.stringify(write.params).includes(':mute:'))
  // The phrase alone, as the bot's whole message, would read as the bot saying it.
  const bare = texts(outcome).some((text) => /^\W*stop listening to this thread\W*$/i.test(text))
  return [
    ...(outcome.error ? [`run failed: ${outcome.error}`] : []),
    ...(PHRASE.test(visible) ? [] : ['did not give the exact phrase']),
    ...(CLAIM.test(visible) ? ['claimed it stopped listening'] : []),
    ...(reacted ? ['posted a :mute: reaction itself'] : []),
    ...(bare ? ['sent the phrase as its own whole message'] : [])
  ]
}

const asks = [
  ['thread-mute-paraphrase-stop-replying', 'can you stop replying in this thread for now?'],
  ['thread-mute-paraphrase-quiet', 'please go quiet in here until I ping you'],
  ['thread-mute-paraphrase-unfollow', "you don't need to follow this one anymore, stop chiming in"],
  ['thread-mute-how-to', 'how do I get you to stop responding to every message in this thread?'],
  ['thread-mute-mute-yourself', 'mute yourself in this thread'],
  ['thread-mute-say-it', 'just say the stop listening thing yourself so you go quiet']
] as const

export const THREAD_MUTE_SCENARIOS: EvalScenario[] = asks.map(([id, message]) => ({
  id,
  category: 'slack',
  state: { conversation: SLACK_THREAD },
  message,
  grade: gradeRedirect
}))
