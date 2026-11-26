// `--ask "<question>" --option "<label>[ | <detail>]"... [--recommended <n>] [--multi]`, once per decision.
// An --option, --recommended or --multi belongs to the --ask before it, so the flags' order is the
// grouping; the parsed flag map loses that order, so it is read again from the command line.
import { CLI_BOOLEAN_FLAGS } from '../../shared/cli/cli-argument-boundary'
import { botItemAskText, type BotItemAsk } from '../../shared/bots/bot-item-ask'
import { RuntimeClientError } from '../runtime/connection/types'
import { getRepeatedStringFlag } from '../arguments/flags'
import type { HandlerContext } from '../dispatch/dispatch'

type AskQuestion = {
  prompt: string
  options: { label: string; detail?: string }[]
  recommended?: number
  multi?: boolean
}

const ASK_FLAGS = new Set(['ask', 'option', 'recommended', 'multi'])

/** Each flag and its value in command-line order, read the way the CLI's own parser reads them. */
function orderedFlags(
  argv: readonly string[],
  booleanFlags: ReadonlySet<string>
): [string, string | true][] {
  const flags: [string, string | true][] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (!token.startsWith('--')) {
      continue
    }
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals !== -1) {
      flags.push([body.slice(0, equals), body.slice(equals + 1)])
      continue
    }
    const next = argv[i + 1]
    if (booleanFlags.has(body) || next === undefined || next.startsWith('--')) {
      flags.push([body, true])
      continue
    }
    flags.push([body, next])
    i += 1
  }
  return flags
}

function fail(message: string): never {
  throw new RuntimeClientError('invalid_argument', message)
}

function option(value: string): { label: string; detail?: string } {
  const bar = value.indexOf('|')
  const label = (bar === -1 ? value : value.slice(0, bar)).trim()
  const detail = bar === -1 ? '' : value.slice(bar + 1).trim()
  return detail ? { label, detail } : { label }
}

/** The decisions `--ask` and its flags spell, or undefined when there is no --ask. */
export function botItemAskFromFlags(
  { flags, rawArgs }: Pick<HandlerContext, 'flags' | 'rawArgs'>,
  booleanFlags: readonly string[]
): { questions: AskQuestion[] } | undefined {
  const asks = getRepeatedStringFlag(flags, 'ask')
  const strays = ['option', 'recommended', 'multi'].filter((name) => flags.has(name))
  if (asks.length === 0) {
    if (flags.has('ask')) {
      // `--ask ""`: a question with no words is no question, never a quiet plain comment.
      fail('--ask needs its question.')
    }
    return strays.length > 0
      ? fail(`--${strays[0]} goes after the --ask it belongs to.`)
      : undefined
  }
  const questions: AskQuestion[] = []
  const booleans = new Set([...CLI_BOOLEAN_FLAGS, ...booleanFlags])
  for (const [name, value] of orderedFlags(rawArgs ?? [], booleans)) {
    if (!ASK_FLAGS.has(name)) {
      continue
    }
    if (name === 'ask') {
      questions.push({ prompt: String(value), options: [] })
      continue
    }
    const question = questions.at(-1) ?? fail(`--${name} goes after the --ask it belongs to.`)
    if (name === 'multi') {
      // A boolean: `--multi=false` would read as on, so any value is refused.
      question.multi = value === true ? true : fail('--multi takes no value.')
    } else if (value === true) {
      fail(`--${name} needs a value.`)
    } else if (name === 'option') {
      question.options.push(option(value))
    } else {
      const index = Number(value)
      if (!Number.isInteger(index) || index < 1 || index > question.options.length) {
        fail('--recommended takes the number of an option given before it, counting from 1.')
      }
      question.recommended = index - 1
    }
  }
  // The re-read must agree with the parser, or the grouping can't be trusted.
  if (questions.map((question) => question.prompt).join('\0') !== asks.join('\0')) {
    fail('Could not read the --ask flags in order; pass each value right after its flag.')
  }
  return { questions }
}

/** The set's `ask` and `comment`: the decisions with `--comment` as their context, and the same ask as
 *  readable text, which a host without asks keeps as a prose question instead of dropping it. */
export function botItemAskParams(
  ask: { questions: AskQuestion[] },
  context: string | undefined
): { ask: BotItemAsk; comment: string } {
  const trimmed = context?.trim()
  const full: BotItemAsk = { ...(trimmed ? { context: trimmed } : {}), questions: ask.questions }
  return { ask: full, comment: botItemAskText(full) }
}
