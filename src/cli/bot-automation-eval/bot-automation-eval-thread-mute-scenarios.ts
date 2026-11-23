// A person in a Slack thread asks the bot, in other words, to stop listening there: the bot tells
// them the exact message to send, never claims it stopped, and never tries to do it itself.
import type { EvalOutcome } from './bot-automation-eval-host'
import type { EvalScenario } from './bot-automation-eval-grading'

const SLACK_THREAD = { source: 'slack' as const, title: 'deploy review' }
const PHRASE = /stop listening to this thread/i
// "I've muted this thread", "Muted.", "Muting this thread now": a claim that it already took effect.
const DONE =
  /(?:^|[^a-z])(?:i've (?:muted|stopped|unfollowed|turned off|gone quiet)|i (?:have )?muted|i'm (?:now )?(?:muted|going quiet|staying quiet)|muting (?:this|the) thread|going quiet now|muted[.!]?$|(?:done|ok|okay)\W+muted)/
// "I'll stop replying here", "I'll hold off": a promise, true only once the person sends the phrase.
const PROMISE =
  /\b(?:(?:i'll|i will) (?:stop|no longer|stay quiet|go quiet|be quiet|keep quiet|stay out|hold off|leave this)|i won't (?:reply|respond|chime|post|answer)|i'm no longer)\b/
// The sentence itself says it hangs on their message ("once you send it", "after that").
const CONDITIONAL =
  /\b(?:once (?:you|it|that|they)|after (?:that|you|it|they)|when (?:you|they) send|if (?:you|they) send|and i'll|and i will|then i)\b/
// Telling them to send the phrase: a send verb and the phrase, in the same or the two sentences before.
const SEND_VERB = /\b(?:send|post|write|type|reply|say|paste|message)\b/

/** What reached the thread: the final message and any `bot reply` text. */
function texts(outcome: EvalOutcome): string[] {
  return [
    outcome.reply,
    ...outcome.writes.flatMap((write) => {
      const args = write.params.args
      const text =
        write.params.text ??
        (typeof args === 'object' && args !== null && 'text' in args ? args.text : undefined)
      const posts = write.method === 'connector.reply' || write.params.verb === 'edit'
      return posts && typeof text === 'string' ? [text] : []
    })
  ]
}

function claims(text: string): boolean {
  const sentences = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\*\*|`/g, '')
    .split(/(?<=[.!?:\n])\s+/)
    .map((sentence) => sentence.trim())
  return sentences.some((sentence, index) => {
    if (DONE.test(sentence)) {
      return true
    }
    if (!PROMISE.test(sentence) || CONDITIONAL.test(sentence)) {
      return false
    }
    const before = sentences.slice(Math.max(0, index - 2), index + 1).join(' ')
    return !(SEND_VERB.test(before) && PHRASE.test(before))
  })
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

// Outside a Slack thread the phrase does nothing: the bot must not hand it out there.
function gradeElsewhere(outcome: EvalOutcome): string[] {
  return [
    ...(outcome.error ? [`run failed: ${outcome.error}`] : []),
    ...(texts(outcome).some((text) => PHRASE.test(text))
      ? ['gave the phrase where it does nothing']
      : [])
  ]
}

export const THREAD_MUTE_SCENARIOS: EvalScenario[] = [
  ...asks.map(([id, message]) => ({
    id,
    category: 'slack' as const,
    state: { conversation: SLACK_THREAD },
    message,
    grade: gradeRedirect
  })),
  {
    id: 'thread-mute-owner-chat',
    category: 'slack',
    message: "go quiet for a bit, I'm thinking",
    grade: gradeElsewhere
  },
  {
    id: 'thread-mute-github-thread',
    category: 'slack',
    state: {
      conversation: { source: 'github', title: 'Fix flaky retry', placeId: 'acme/api#12' }
    },
    message: 'stop replying to every review comment on this PR',
    grade: gradeElsewhere
  }
]
