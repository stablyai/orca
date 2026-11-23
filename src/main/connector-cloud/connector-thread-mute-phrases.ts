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

// Longer than any phrase with "please" and "thanks": never a directive, and never scanned further,
// so a long reply costs nothing here.
const MAX_DIRECTIVE_LENGTH = 100

// One line of letters, spaces and commas, with at most one trailing "." or "!": an allowlist, so a
// question mark, quote, backtick, `>`, `<`, `@`, emoji or newline in any script never passes.
const PLAIN = /^[\p{L} ,]+[.!]?$/u

/** Whether the sender's own words are exactly a directive to stop listening: one listed phrase,
 *  with an optional leading "please" or trailing ", please" or ", thanks", and nothing else, so a
 *  sentence that merely contains one ("Alice said stop listening here") never is. */
export function isThreadMuteDirective(spoken: string | undefined): boolean {
  const trimmed = spoken?.trim() ?? ''
  if (trimmed.length > MAX_DIRECTIVE_LENGTH || !PLAIN.test(trimmed)) {
    return false
  }
  const plain = trimmed
    .replace(/[.!]$/, '')
    .toLowerCase()
    .replace(/ +/g, ' ')
    .replace(/ ?, ?/g, ', ')
    .trim()
    .replace(/^please /, '')
    .replace(/, (?:please|thanks)$/, '')
  return PHRASES.has(plain)
}
