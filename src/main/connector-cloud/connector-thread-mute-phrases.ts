// Whether a reply to a bot's Slack thread tells the bot to stop listening there: the sender's own
// words, plain text only, and exactly one listed phrase. Anything else (a quote, code, a forward, a
// question in any script, an emoji, extra words) is no directive, so no random message mutes.
export const THREAD_MUTE_PHRASES = [
  'stop listening to this thread',
  'stop listening in this thread',
  'stop listening here',
  'stop following this thread',
  'unfollow this thread',
  'mute this thread',
  'stop replying in this thread',
  'stop responding in this thread',
  'stop replying here',
  'stop responding here'
]

const PHRASES = new Set(THREAD_MUTE_PHRASES)
const MAX_DIRECTIVE_WORDS = 8

// One line of letters, spaces and commas, with at most one trailing "." or "!": an allowlist, so a
// question mark, quote, backtick, `>`, `<`, `@`, emoji or newline in any script never passes.
const PLAIN = /^[\p{L} ,]+[.!]?$/u

function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s*,\s*/g, ', ')
    .replace(/ +/g, ' ')
    .trim()
}

function isPhrase(rest: string): boolean {
  const plain = rest.replace(/^please /, '').replace(/, (?:please|thanks)$/, '')
  return PHRASES.has(plain)
}

/** Whether the sender's own words are a directive to stop listening, after an optional leading
 *  exact name of this bot (several bots may share one Slack app). `any` takes any leading words,
 *  for batching, which only keeps a likely directive out of a turn. */
export function isThreadMuteDirective(
  spoken: string | undefined,
  botNames: readonly string[] | 'any'
): boolean {
  const trimmed = spoken?.trim() ?? ''
  if (!PLAIN.test(trimmed)) {
    return false
  }
  const rest = words(trimmed.replace(/[.!]$/, ''))
  if (isPhrase(rest)) {
    return true
  }
  if (botNames === 'any') {
    // No phrase, with its "please" and ", thanks", runs past the last few words.
    const all = rest.split(' ')
    for (let index = Math.max(1, all.length - MAX_DIRECTIVE_WORDS); index < all.length; index++) {
      if (isPhrase(all.slice(index).join(' '))) {
        return true
      }
    }
    return false
  }
  return botNames.some((name) => {
    const named = words(name)
    return named !== '' && rest.startsWith(`${named} `) && isPhrase(rest.slice(named.length + 1))
  })
}
