// Look and tidy-up runs store their failure as English; views send its code with it, read back from
// that text, so runs stored before codes existed translate too.
import {
  BOT_FAILURE_COPY,
  botFailure,
  type BotFailure,
  type BotFailureCode
} from '../../shared/bots/bot-failure-copy'

type Matcher = { code: BotFailureCode; pattern: RegExp; names: string[] }

let matchers: Matcher[] | undefined

function runFailureMatchers(): Matcher[] {
  matchers ??= (Object.keys(BOT_FAILURE_COPY) as BotFailureCode[])
    .filter((code) => code.startsWith('look') || code.startsWith('tidyUp'))
    .map((code) => {
      // Splitting on a captured slot alternates literal text and slot names.
      const parts = BOT_FAILURE_COPY[code].split(/\{\{(\w+)\}\}/)
      const names = parts.filter((_, index) => index % 2 === 1)
      const source = parts
        .map((part, index) =>
          index % 2 === 1 ? '(.+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        )
        .join('')
      return { code, pattern: new RegExp(`^${source}$`, 's'), names }
    })
  return matchers
}

export function botRunFailure(error: string | null | undefined): BotFailure | undefined {
  if (!error) {
    return undefined
  }
  for (const { code, pattern, names } of runFailureMatchers()) {
    const match = pattern.exec(error)
    if (match) {
      return botFailure(code, Object.fromEntries(names.map((name, at) => [name, match[at + 1]!])))
    }
  }
  return undefined
}
