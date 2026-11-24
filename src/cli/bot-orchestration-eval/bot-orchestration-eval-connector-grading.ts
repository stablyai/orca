// Checks for what a bot does through its connectors' newer verbs: which place it acts on and what it
// sends, however a verb's arguments are shaped, and what it must not post or list.
// bot-orchestration-eval-grading.test.ts runs each against deliberately wrong traces.
import { z } from 'zod'
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import { COMMAND_SPECS } from '../specs'
import type { EvalRecordedWrite, EvalTurnOutcome } from './bot-orchestration-eval-conversation'
import { writes, type TurnCheck } from './bot-orchestration-eval-grading'

/** A write reached a place this id names as a whole part (ENG-9310 never matches ENG-93100): the
 *  place the stand-in resolved, else the bot's own input. */
function reaches(write: EvalRecordedWrite, id: string): boolean {
  const place =
    write.result && 'target' in write.result ? write.result.target : String(write.params.ref ?? '')
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[:/])${escaped}($|[:/?#])`).test(place)
}

/** The bot used its connector's verb on a place one of these ids names (any, when none), and what
 *  it sent carries each fact, however the verb's arguments are shaped. */
export function actsOn(verb: string, ids: string[], ...facts: RegExp[]): TurnCheck {
  return (turn) => {
    const acts = writes(turn, `connector.${verb}`).filter(
      (act) => !ids.length || ids.some((id) => reaches(act, id))
    )
    if (!acts.length) {
      return [`no connector ${verb} on ${ids[0] ?? 'any place'}`]
    }
    const sent = acts.map((act) => JSON.stringify(act.params.args ?? {}))
    return facts
      .filter((fact) => !sent.some((args) => fact.test(args)))
      .map((fact) => `the ${verb} leaves out ${fact}`)
  }
}

/** The bot attached one file, on a place one of these ids names, that holds every text. */
export function attaches(ids: string[], ...texts: string[]): TurnCheck {
  return (turn) => {
    const files = writes(turn, 'connector.attach')
      .filter((act) => ids.some((id) => reaches(act, id)))
      .map(fileText)
    if (!files.length) {
      return [`no file attached on ${ids[0]}`]
    }
    const missing = Math.min(
      ...files.map((file) => texts.filter((text) => !file.includes(text)).length)
    )
    return missing > 0 ? [`the fullest file leaves out ${missing} of ${texts.length} lines`] : []
  }
}

/** What the bot said quotes at most a few of these lines: naming the line that matters is fine,
 *  pasting the file is not. */
export function pastesAtMost(lines: readonly string[], max: number, what: string): TurnCheck {
  return (turn) => {
    const texts = said(turn)
    const pasted = lines.filter((line) => texts.some((text) => text.includes(line))).length
    return pasted > max ? [`reply pastes ${pasted} lines of ${what}`] : []
  }
}

/** Nothing new reaches the thread: no post, and the turn ends quiet, since Orca posts a final answer. */
export const postsNothing: TurnCheck = (turn) => [
  ...([...writes(turn, 'connector.post'), ...writes(turn, 'connector.reply')].length
    ? ['posted a new message']
    : []),
  ...(isQuietBotResult(turn.reply) ? [] : ['its final answer posts a new message'])
]

const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s/

/** The reply's list leaves these out; a passing mention ("PLAT-45 isn't a bug") is fine. */
export function listsNone(...keys: string[]): TurnCheck {
  return (turn) => {
    const items = turn.reply.split('\n').filter((line) => LIST_ITEM.test(line))
    return keys
      .filter((key) => items.some((item) => new RegExp(`\\b${key}\\b`).test(item)))
      .map((key) => `lists ${key}`)
  }
}

// What a connector write carries in words: a reply's text, or a verb's text and attached file.
const Written = z.looseObject({
  text: z.string().optional(),
  args: z
    .looseObject({
      text: z.string().optional(),
      title: z.string().optional(),
      file: z.looseObject({ name: z.string().optional(), data: z.string() }).optional()
    })
    .optional()
})

/** An attached file's contents, decoded; empty for any other write. */
function fileText(write: EvalRecordedWrite): string {
  const data = Written.safeParse(write.params).data?.args?.file?.data
  return data ? Buffer.from(data, 'base64').toString('utf8') : ''
}

const OUTBOUND = ['connector.post', 'connector.reply', 'connector.attach', 'connector.edit']

/** Everything the bot said: its final answer, and the words of each post, reply, attachment and
 *  edit, whichever shape each records them in. */
function said(turn: EvalTurnOutcome): string[] {
  const words = OUTBOUND.flatMap((method) =>
    writes(turn, method).flatMap((write) => {
      const written = Written.safeParse(write.params).data
      return [written?.text, written?.args?.text].filter((text): text is string => Boolean(text))
    })
  )
  // A quiet final answer is never posted.
  return [...(isQuietBotResult(turn.reply) ? [] : [turn.reply]), ...words]
}

/** All the bot sent anywhere: what it said, and each title, file name and file it wrote. */
function sent(turn: EvalTurnOutcome): string[] {
  const rest = OUTBOUND.flatMap((method) =>
    writes(turn, method).flatMap((write) => {
      const args = Written.safeParse(write.params).data?.args
      return [args?.title, args?.file?.name, fileText(write)].filter((text): text is string =>
        Boolean(text)
      )
    })
  )
  return [...said(turn), ...rest]
}

/** What the bot asked reaches the person, by a mention of their Slack id, and carries each fact. */
export function asks(userId: string, ...facts: RegExp[]): TurnCheck {
  return (turn) => {
    const reaching = said(turn).filter((text) => text.includes(`<@${userId}>`))
    if (!reaching.length) {
      return [`did not reach ${userId}`]
    }
    return facts
      .filter((fact) => !reaching.some((text) => fact.test(text)))
      .map((fact) => `what reached ${userId} leaves out ${fact}`)
  }
}

/** The bot searched the workspace by its ref, or by a name that reaches it alone (in any case),
 *  however the flags are ordered. */
export function searches(ref: string, ...names: string[]): TurnCheck {
  const reaches = (arg: string) =>
    arg === ref || names.some((name) => name.toLowerCase() === arg.toLowerCase())
  return (turn) =>
    turn.commands.some((argv) => {
      const target = searchTarget(argv)
      return target !== undefined && reaches(target)
    })
      ? []
      : [`did not search ${ref}`]
}

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

/** What a `slack find --search` names, as the CLI itself reads argv. */
function searchTarget(argv: string[]): string | undefined {
  const { commandPath, flags } = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(argv, COMMAND_PATHS, COMMAND_SPECS)
  )
  // With no place given, the CLI searches the --workspace one (slack.ts).
  const place = flags.get('query') ?? flags.get('workspace')
  return commandPath.join(' ') === 'slack find' && flags.has('search') && typeof place === 'string'
    ? place
    : undefined
}

/** What the bot said in the conversation carries the fact: its final answer, or a reply or post. */
export function tells(fact: RegExp, what: string): TurnCheck {
  return (turn) => (said(turn).some((text) => fact.test(text)) ? [] : [`never told ${what}`])
}

/** Nothing the bot sent carries any of these facts: what the conversation it answers can't see. */
export function quotesNone(what: string, ...facts: RegExp[]): TurnCheck {
  return (turn) =>
    facts.some((fact) => sent(turn).some((text) => fact.test(text))) ? [`quoted ${what}`] : []
}
