// What a message to a bot's Slack thread says about its mute: a whole-message mute or unmute
// command past mentions of the bot, and whether it @mentions this bot or another behind its app.
export type ThreadMuteCommand = 'mute' | 'unmute'

// Whole messages only, and none a one-word answer to a question could be ("quiet").
const MUTE_PHRASES = [
  'mute',
  'mute this',
  'mute here',
  'mute this thread',
  'mute thread',
  'be quiet',
  'stay quiet',
  'go quiet',
  'stop responding',
  'stop responding here',
  'stop responding in this thread',
  'stop replying',
  'stop replying here',
  'stop replying in this thread'
]
const UNMUTE_PHRASES = [
  'unmute',
  'unmute this',
  'unmute here',
  'unmute this thread',
  'unmute thread',
  'start responding',
  'start responding again',
  'start replying again',
  'resume responding',
  'you can respond again'
]

const MAX_COMMAND_WORDS = 8

const COMMANDS = new Map<string, ThreadMuteCommand>([
  ...MUTE_PHRASES.map((phrase) => [phrase, 'mute'] as const),
  ...UNMUTE_PHRASES.map((phrase) => [phrase, 'unmute'] as const)
])

/** How people address the thread's bot: its Slack user (`<@U…>`; a shared app's bots share one,
 *  told apart by the name after it) and its names (`@reviewer`). */
export type ThreadBot = {
  userId: string | null
  names: readonly string[]
  /** Other bots' names: after a shared app's mention, one of these addresses that bot instead. */
  others?: readonly string[]
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2019']/g, '')
    .replace(/[^\p{L}\p{N}@<>\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The longest name first: "reviewer 2" (folder reviewer-2) before its bot's name "reviewer".
function afterName(rest: string, names: readonly string[]): string | null {
  const name = [...names]
    .sort((a, b) => b.length - a.length)
    .find((entry) => rest === entry || rest.startsWith(`${entry} `))
  return name === undefined ? null : rest.slice(name.length).trimStart()
}

/** The message past its leading mentions of `bot`; null when one names someone else, so "@Bob
 *  mute" or a mute for another bot never mutes this one. `any` takes every mention (batching, which
 *  only needs to keep a likely command out of a turn). */
function pastMentions(text: string, bot: ThreadBot | 'any'): string | null {
  let rest = normalized(text)
  const names =
    bot === 'any' ? [] : bot.names.map((name) => normalized(name)).filter((name) => name !== '')
  const userId = bot === 'any' ? null : bot.userId?.toLowerCase()
  for (;;) {
    const slack = /^<@([^>]+)>\s*/.exec(rest)
    const token = /^@\S+\s*/.exec(rest)
    if (slack) {
      if (bot !== 'any' && slack[1] !== userId) {
        return null
      }
      rest = rest.slice(slack[0].length)
      rest = afterName(rest, names) ?? rest
    } else if (token) {
      // "@reviewer", or a shared app's "@Orca reviewer".
      const named = afterName(rest.slice(1), names) ?? afterName(rest.slice(token[0].length), names)
      if (bot !== 'any' && named === null) {
        return null
      }
      rest = named ?? rest.slice(token[0].length)
    } else {
      return rest
    }
  }
}

function commandOf(rest: string): ThreadMuteCommand | null {
  const plain = rest
    .replace(/^please /, '')
    .replace(/ please$/, '')
    .replace(/ thanks$/, '')
  return COMMANDS.get(plain) ?? null
}

/** The command a whole message is, past leading mentions of the bot and a "please"; null for
 *  anything else ("mute the video", "don't mute", a question like "mute?"). */
export function threadMuteCommand(text: string, bot: ThreadBot): ThreadMuteCommand | null {
  // A question anywhere ("mute?!", "mute? 🤔") asks about muting, and code (`mute`) quotes it:
  // neither mutes.
  const rest = text.includes('?') || text.includes('`') ? null : pastMentions(text, bot)
  return rest === null ? null : commandOf(rest)
}

/** Whether a message may be a mute command for some bot, its handle unknown: kept out of batches. */
export function mayBeThreadMuteCommand(text: string): boolean {
  const rest = pastMentions(text, 'any') ?? ''
  const mentioned = rest !== normalized(text)
  if (commandOf(rest) !== null) {
    return true
  }
  // A mention may name its bot in the words after it ("@Orca Reviewer bot mute"); no phrase, with
  // its "please" and "thanks", runs past the last few words.
  const words = rest.split(' ')
  const tail = Math.max(1, words.length - MAX_COMMAND_WORDS)
  for (let drop = tail; mentioned && drop < words.length; drop++) {
    if (commandOf(words.slice(drop).join(' ')) !== null) {
      return true
    }
  }
  return false
}

/** Whether the message @mentions the bot anywhere, as its Slack user or by a whole name ("@reviewer"
 *  is not "@reviewer-2", nor "ops@reviewer.io"). */
export function mentionsBot(text: string, bot: ThreadBot): boolean {
  // Code (```blocks``` and `spans`) only quotes a name; it mentions no one.
  const lower = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .toLowerCase()
  const userId = bot.userId?.toLowerCase()
  return (
    (userId !== undefined && lower.includes(`<@${userId}>`)) ||
    bot.names.some((name) => {
      const at = `@${name.toLowerCase().trim()}`
      return (
        at.length > 1 &&
        lower
          .split(at)
          .some(
            (after, index, parts) =>
              index > 0 &&
              !/[\p{L}\p{N}_.-]$/u.test(parts[index - 1]) &&
              !/^[\p{L}\p{N}_-]/u.test(after)
          )
      )
    })
  )
}

/** Whether the message, cleaned up as the other checks read it, starts with `<@userId>`. */
export function leadsWithBotUser(text: string, userId: string): boolean {
  return normalized(text).startsWith(`<@${userId.toLowerCase()}>`)
}

/** Whether the message leads with the shared Slack user's mention and then another bot's name
 *  (longest first), so it is that bot's, not this one's. */
export function addressesOtherBot(text: string, bot: ThreadBot): boolean {
  const userId = bot.userId?.toLowerCase()
  const rest = normalized(text)
  const prefix = `<@${userId}>`
  if (!userId || !bot.others?.length || !leadsWithBotUser(text, userId)) {
    return false
  }
  const after = rest.slice(prefix.length).trimStart()
  const named = [
    ...bot.names.map((name) => ({ name: normalized(name), other: false })),
    ...bot.others.map((name) => ({ name: normalized(name), other: true }))
  ]
    .filter(({ name }) => name !== '' && (after === name || after.startsWith(`${name} `)))
    .sort((a, b) => b.name.length - a.name.length)
  return named[0]?.other === true
}
