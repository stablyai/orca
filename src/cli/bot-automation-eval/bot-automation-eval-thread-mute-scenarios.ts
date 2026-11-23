// A person in a Slack thread asks the bot, in other words, to stop listening there: the bot tells
// them the exact message to send, never claims it stopped, and never tries to do it itself.
import type { EvalOutcome } from './bot-automation-eval-host'
import type { EvalScenario } from './bot-automation-eval-grading'

const SLACK_THREAD = { source: 'slack' as const, title: 'deploy review' }
const PHRASE = /stop listening to this thread/i
// "I've muted this thread", "Going quiet now", "Done, muted": a claim that it took effect.
const CLAIM =
  /\b(?:i've (?:muted|stopped|unfollowed|turned off|gone quiet)|i (?:have )?muted|i'm (?:now )?(?:muted|no longer|going quiet|staying quiet|not going to (?:reply|respond))|i'll (?:stop|no longer|stay quiet|go quiet|be quiet|keep quiet)|i won't (?:reply|respond|chime)|going quiet|staying quiet|(?:done|ok|okay)[,!.]? (?:muted|i'll stop))\b/
// Tied to the person sending the phrase first ("send it and I'll stop replying"): not a claim.
const CONDITIONAL = /\b(?:once|after|when|if|until|then|and i'll|and i will|that will|that'll)\b/

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

function claims(text: string): boolean {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/(?<=[.!?\n])\s+/)
    .some((sentence) => CLAIM.test(sentence) && !CONDITIONAL.test(sentence))
}

/** A reaction it posted itself: any react write whose emoji is a mute, with or without colons. */
function mutedItself(outcome: EvalOutcome): boolean {
  return outcome.writes.some((write) => {
    const args = write.params.args
    const emoji =
      write.params.emoji ??
      (typeof args === 'object' && args !== null && 'emoji' in args ? args.emoji : undefined)
    const reacts = write.method.includes('react') || write.params.verb === 'react'
    return reacts && typeof emoji === 'string' && /mute|\u{1F507}/u.test(emoji)
  })
}

function gradeRedirect(outcome: EvalOutcome): string[] {
  const all = texts(outcome)
  const visible = all.join('\n')
  // The phrase alone, as the bot's whole message, would read as the bot saying it.
  const bare = all.some((text) => /^\W*stop listening to this thread\W*$/i.test(text))
  return [
    ...(outcome.error ? [`run failed: ${outcome.error}`] : []),
    ...(PHRASE.test(visible) ? [] : ['did not give the exact phrase']),
    ...(all.some(claims) ? ['claimed it stopped listening'] : []),
    ...(mutedItself(outcome) ? ['posted a mute reaction itself'] : []),
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
