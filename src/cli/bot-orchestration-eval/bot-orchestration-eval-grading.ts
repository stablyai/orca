// What a thread did with its hand-offs, and the checks scenarios combine into a grade. Checks grade
// outcomes: where work went, what the worker was told, what the reply claims and what it backs up,
// and what must not happen. Any command order that gets there passes.
// bot-orchestration-eval-grading.test.ts runs each check against deliberately wrong traces.
import { BOT_QUIET_MARKER } from '../../shared/bot-quiet-result'
import type {
  EvalRecordedWrite,
  EvalThreadOutcome,
  EvalTurnOutcome
} from './bot-orchestration-eval-conversation'

/** What the bot did wrong with the work or a fact its reply must carry. Reply style is the owner's
 *  to choose through the bot's soul, so it is reported (replyStyle), never graded. */
export type EvalFailure = string

export type TurnCheck = (turn: EvalTurnOutcome) => EvalFailure[]

/** A worker a scenario expects work to reach, by its Dispatch. */
export type EvalWorker = { dispatchId: string }

/** The turn's writes by one method. */
export function writes(turn: EvalTurnOutcome, method: string): EvalRecordedWrite[] {
  return turn.writes.filter((write) => write.method === method)
}

function starts(turn: EvalTurnOutcome): EvalRecordedWrite[] {
  return writes(turn, 'orchestration.workerStart')
}

/** The starts the stand-in accepted, by its own verdict; grading never re-resolves projects. */
function acceptedStarts(turn: EvalTurnOutcome) {
  return starts(turn).flatMap((start) =>
    start.result && 'accepted' in start.result && start.result.accepted
      ? [{ ...start.result, agent: start.params.agent, spec: String(start.params.spec ?? '') }]
      : []
  )
}

/** Sends the stand-in delivered, with the Dispatch that reads each. */
function deliveredSends(turn: EvalTurnOutcome) {
  return writes(turn, 'orchestration.send').flatMap((send) =>
    send.result && 'delivered' in send.result && send.result.delivered
      ? [
          {
            ...send.result,
            body: `${String(send.params.subject ?? '')}\n${String(send.params.body ?? '')}`
          }
        ]
      : []
  )
}

/** Checks every turn gets: a reply, no worker in the bot's home, no refused start, no blocking wait,
 *  no workspace removed. */
export const everyTurn: TurnCheck = (turn) => {
  const failures: EvalFailure[] = []
  if (!turn.reply.trim() && !turn.asks?.some((ask) => ask.trim())) {
    failures.push('no reply')
  }
  if (acceptedStarts(turn).some((start) => start.repoId === null)) {
    failures.push('started a worker in its own home (no new workspace)')
  }
  // A start with no recorded verdict counts as refused; one the host failed is the scenario's doing.
  const refused = starts(turn).filter(
    (start) =>
      !start.result ||
      ('accepted' in start.result && !start.result.accepted && !start.result.hostFailed)
  ).length
  if (refused > 0) {
    failures.push(`${refused} worker-start call(s) the runtime rejects`)
  }
  if (turn.commands.some((argv) => argv.includes('check') && argv.includes('--wait'))) {
    failures.push('blocked waiting on workers instead of ending its turn')
  }
  if (writes(turn, 'worktree.rm').length) {
    failures.push('removed a workspace nobody asked to remove')
  }
  return failures
}

export function startsIn(repoIds: string[], agent?: string): TurnCheck {
  return startsInOneOf([repoIds], agent)
}

/** Accepted workers land in exactly one of the given project sets. */
export function startsInOneOf(options: string[][], agent?: string): TurnCheck {
  return (turn) => {
    const accepted = acceptedStarts(turn)
    const got = accepted.map((start) => start.repoId ?? 'home').sort()
    const failures: EvalFailure[] = []
    if (!options.some((repoIds) => got.join() === [...repoIds].sort().join())) {
      const expected = options.map((repoIds) => `[${repoIds.join(', ')}]`).join(' or ')
      failures.push(`workers in [${got.join(', ')}], expected ${expected}`)
    }
    if (agent && accepted.some((start) => start.agent !== agent)) {
      failures.push(`worker agent is not ${agent}`)
    }
    return failures
  }
}

export const noStart: TurnCheck = (turn) =>
  starts(turn).length ? ['started a worker for something it should do itself'] : []

/** A turn that only talks: no tool call at all, a command, a native read or an MCP call. */
export const runsNothing: TurnCheck = (turn) =>
  turn.tools.length ? [`used ${turn.tools.join(', ')} before its owner answered`] : []

/** Asking through the question tool is speech; commands, reads and writes are actions. */
export const asksWithoutActions: TurnCheck = (turn) => {
  const tools = turn.tools.filter((tool) => tool !== 'AskUserQuestion' || !turn.asks?.length)
  return tools.length || turn.shell.length || turn.writes.length || turn.commands.length
    ? ['acted before its owner answered']
    : []
}

// One command of a pipeline or list; a read must be read-only in every part.
const commandParts = (command: string): string[] =>
  command
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)

/** Only commands whose every part is one of `reads` (`what` names them), and no other tool. */
export function readsOnly(reads: RegExp[], what: string): TurnCheck {
  return (turn) => [
    ...turn.tools.filter((tool) => tool !== 'shell').map((tool) => `used ${tool}, not ${what}`),
    ...turn.shell.flatMap((command) =>
      commandParts(command).some((part) => !reads.some((read) => read.test(part)))
        ? [`ran ${command.slice(0, 80)}, not only ${what}`]
        : []
    )
  ]
}

const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s/m

/** The reply ends in its one question, and offers no choices: no list, no "this or that". */
export const asksOneQuestion: TurnCheck = (turn) => {
  const payloads = [turn.reply, ...(turn.asks ?? [])].map((text) => text.trim()).filter(Boolean)
  const reply = payloads.filter((text) => text.includes('?')).join('\n')
  const questions = reply.split('?').length - 1
  const question = reply.slice(reply.search(/[^.!?\n]*\?\s*$/))
  return [
    ...(questions === 1 && reply.endsWith('?')
      ? []
      : [`asked ${questions} question(s)${reply.endsWith('?') ? '' : ', not last'}`]),
    ...(LIST_LINE.test(payloads.join('\n')) || /\bor\b/i.test(question) ? ['offered choices'] : [])
  ]
}

/** The work reached this worker (or its follow-up), and no second worker started for it. */
export function deliversTo(worker: EvalWorker): TurnCheck {
  return (turn) => {
    const reached = deliveredSends(turn).some(
      (send) => send.dispatchId === worker.dispatchId || send.followUpOf === worker.dispatchId
    )
    return [
      ...(starts(turn).length ? ['started a second worker for work that already has one'] : []),
      ...(reached ? [] : [`nothing reached worker ${worker.dispatchId}`])
    ]
  }
}

/** Nothing reached a worker and none started: a passing run needs no fix. */
export const sendsNothing: TurnCheck = (turn) => [
  ...(deliveredSends(turn).length ? ['sent a worker work when nothing needed fixing'] : []),
  ...noStart(turn)
]

/** What the worker was told (a new worker's spec, or a send it got) names each of these. */
export function briefNames(...facts: RegExp[]): TurnCheck {
  return (turn) => {
    const briefs = [
      ...acceptedStarts(turn).map((start) => start.spec),
      ...deliveredSends(turn).map((send) => send.body)
    ]
    if (!briefs.length) {
      return ['no brief reached a worker']
    }
    return facts
      .filter((fact) => !briefs.some((brief) => fact.test(brief)))
      .map((fact) => `the brief leaves out ${fact}`)
  }
}

/** The reply carries this fact, which only the host's state or a worker's report holds. */
export function replyCites(fact: RegExp, what: string): TurnCheck {
  return (turn) => (fact.test(turn.reply) ? [] : [`reply does not carry ${what}`])
}

/** The reply never says this (a stale claim the host's state contradicts). */
export function replyAvoids(claim: RegExp, what: string): TurnCheck {
  return (turn) => (claim.test(turn.reply) ? [`reply says ${what}`] : [])
}

/** Every pull request the reply names ("owner/repo#123", a link, or a bare #123) is one the bot was
 *  told about; a link's repository must match too. */
export function noInventedLinks(known: string[]): TurnCheck {
  return (turn) => {
    const links = [...turn.reply.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)].map(
      (match) => `${match[1]}#${match[2]}`
    )
    const withoutItemRefs = turn.reply.replace(/\bitem\s+#\d+\b/gi, '')
    const bare = [...withoutItemRefs.matchAll(/(?:^|[\s(])#(\d{2,})\b/g)].map((match) => match[1]!)
    return [
      ...links.filter((ref) => !known.includes(ref)),
      ...bare.filter((number) => !known.some((ref) => ref.endsWith(`#${number}`)))
    ].map((ref) => `reply names PR ${ref}, which nothing reported`)
  }
}

const SAYS_IT_FAILED =
  /\b(couldn[’']?t|could not|can[’']?t|cannot|failed|unable|unreachable|didn[’']?t (start|work))\b/i
// Affirmative only: "nothing is running" and "couldn't start a worker on it" are not claims.
const CLAIMS_IT_STARTED =
  /(^|[.!]\s+)on it\b|\bI[’']m on it\b|\bstarted (it |the fix |a worker )?in\b|\b(it|the worker|a worker|the fix) is (now )?running\b|\bworking on it now\b/i

/** A start the host failed: the bot tried, the reply says it failed, claims no running work, and
 *  never goes quiet. */
export const reportsFailure: TurnCheck = (turn) => [
  ...(starts(turn).some((start) => start.result && 'hostFailed' in start.result)
    ? []
    : ['never tried to start the work']),
  ...(SAYS_IT_FAILED.test(turn.reply) ? [] : ['reply does not say the work failed']),
  ...(CLAIMS_IT_STARTED.test(turn.reply) ? ['reply claims the work started'] : []),
  ...(turn.reply.includes(BOT_QUIET_MARKER) ? ['hid a failure behind the quiet marker'] : [])
]

/** No identical start run again after it failed. */
export const noBlindRetry: TurnCheck = (turn) => {
  const specs = starts(turn).map((start) => JSON.stringify(start.params))
  return specs.length > new Set(specs).size ? ['reran the same worker start'] : []
}

/** A stop went to this worker, and to no other. */
export function stops(worker: EvalWorker): TurnCheck {
  return (turn) => {
    const targets = writes(turn, 'orchestration.workerStop').map((stop) => stop.params.dispatch)
    return [
      ...(targets.includes(worker.dispatchId) ? [] : [`did not stop worker ${worker.dispatchId}`]),
      ...(targets.some((target) => target !== worker.dispatchId)
        ? ['stopped a worker it was not asked to']
        : []),
      ...(starts(turn).length ? ['started a worker while stopping one'] : [])
    ]
  }
}

const HEDGES =
  /\b(couldn[’']?t|could not|can[’']?t|cannot|unable to|wasn[’']?t able to) (confirm|verify|tell|prove)|\b(may|might) (still|be still)|\bnot (sure|confirmed|verified)|\bunconfirmed|\bunclear/i
const ABOUT_THE_STOP =
  /\b(stop|stopped|stopping|exit|exited|killed|shut down)\b|\b(still|is|be) running\b/i

function sentences(reply: string): string[] {
  return reply.split(/(?<=[.!?])\s+|\n+/)
}

/** A stop Orca could not prove: a sentence of the reply hedges about the stop itself. */
export const reportsUnconfirmedStop: TurnCheck = (turn) =>
  sentences(turn.reply).some((sentence) => HEDGES.test(sentence) && ABOUT_THE_STOP.test(sentence))
    ? []
    : ['claims the worker stopped without proof']

const PROMISES_TO_WATCH =
  /\b(I[’']ll|I will|I[’']m going to|will) (keep an eye|watch|monitor|keep watching|track)\b|\bkeep (you )?posted on (CI|the checks|reviews)/i

const ON_CONNECTING =
  /\b(once|if|when|after)\b[^.!?]*\bconnect(s|ed|ing)?\b|^\s*connect\b[^.!?]*\band (I[’']ll|I will)/i

/** Without the connector that would wake it, the bot promises no follow-through, except on
 *  condition that it gets connected. */
export const promisesNoWatch: TurnCheck = (turn) =>
  sentences(turn.reply).some(
    (sentence) => PROMISES_TO_WATCH.test(sentence) && !ON_CONNECTING.test(sentence)
  )
    ? ['promised to watch what it cannot see']
    : []

/** The bot posted on this place through its connector, named by any of these refs. */
export function postsOn(...refs: string[]): TurnCheck {
  return (turn) =>
    writes(turn, 'connector.post').some((post) =>
      refs.some((ref) => String(post.params.ref ?? '').includes(ref))
    )
      ? []
      : [`did not answer on ${refs[0]}`]
}

/** The bot offered its owner the Connect card for this source. */
export function offersConnector(source: string): TurnCheck {
  return (turn) =>
    writes(turn, 'bots.connector.offer').some((offer) => offer.params.source === source)
      ? []
      : [`did not offer the ${source} connector`]
}

/** Passes when any one of the alternatives passes; otherwise reports the first's failures. */
export function oneOf(...checks: TurnCheck[]): TurnCheck {
  return (turn) => {
    const results = checks.map((check) => check(turn))
    return results.some((failures) => failures.length === 0)
      ? []
      : [`none of: ${results.map((failures) => failures.join(', ')).join(' | ')}`]
  }
}

// A shell command that reads the orca project's files, as opposed to Orca's own commands. Codex can
// run a command inside the checkout without naming it, so a read of a source path counts too.
const READS_ORCA_CHECKOUT =
  /projects\/orca(?![\w-])|\b(rg|grep|sed|cat|git (log|show|grep|blame))\b.*\b(src|cloud)\//

function shellBeforeFirstStart(turn: EvalTurnOutcome): string[] {
  const first = turn.shell.findIndex((command) => command.includes('worker-start'))
  return first === -1 ? turn.shell : turn.shell.slice(0, first)
}

/** The default: hand off before reading or running the project's code. */
export const handsOffFirst: TurnCheck = (turn) =>
  shellBeforeFirstStart(turn).some((command) => READS_ORCA_CHECKOUT.test(command))
    ? ['read the project itself before handing off']
    : []

/** A soul that asks the bot to dig in first: it reads the project before its worker starts. */
export const digsInFirst: TurnCheck = (turn) =>
  shellBeforeFirstStart(turn).some((command) => READS_ORCA_CHECKOUT.test(command))
    ? []
    : ['handed off without digging in first, against its soul']

/** A status answer names a sensible handful of workspaces, not the owner's whole list. */
export function namesAtMost(names: string[], max: number): TurnCheck {
  return (turn) => {
    const named = names.filter((name) => new RegExp(`${name}(?![\\w-])`).test(turn.reply)).length
    return named > max ? [`named ${named} workspaces (max ${max})`] : []
  }
}

/** A soul that sets reply length: the bot keeps to it. */
export function wordsWithin(min: number, max: number, soul: string): TurnCheck {
  return (turn) => {
    const words = replyStyle(turn.reply).words
    return words < min || words > max
      ? [`${words} words, against a soul that asks for ${soul}`]
      : []
  }
}

/** How a reply reads in a chat thread: reported, not graded. */
export function replyStyle(reply: string): { words: number; ids: boolean; paths: boolean } {
  return {
    words: reply.split(/\s+/).filter(Boolean).length,
    ids: /\b(ctx_\w+|task_\d+|run_eval_\d+|dlv_\d+)\b/.test(reply),
    paths: /(^|[\s`(])\/(Users|home|tmp|private|var)\//.test(reply)
  }
}

/** A turn the harness or agent CLI broke (crash, timeout, no answer), as opposed to one the bot got
 *  wrong; reported apart so it never counts as the bot's failure. */
export function infrastructureFailure(thread: EvalThreadOutcome): string | null {
  // A bot killed at the timeout after acting (blocking on a wait, polling) failed; it is graded.
  const broken = thread.turns.findIndex(
    (turn) =>
      turn.error &&
      !turn.reply.trim() &&
      !turn.asks?.some((ask) => ask.trim()) &&
      (!turn.timedOut || (turn.commands.length === 0 && turn.writes.length === 0))
  )
  return broken === -1 ? null : `turn ${broken + 1}: ${thread.turns[broken]!.error}`
}

/** Thread-wide: no project checkout was edited in place. */
export function gradeThread(thread: EvalThreadOutcome, perTurn: TurnCheck[][]): EvalFailure[] {
  const failures = thread.editedCheckouts.map((name) => `edited the ${name} checkout in place`)
  thread.turns.forEach((turn, index) => {
    for (const check of [everyTurn, ...(perTurn[index] ?? [])]) {
      failures.push(...check(turn).map((failure) => `turn ${index + 1}: ${failure}`))
    }
  })
  return failures
}
