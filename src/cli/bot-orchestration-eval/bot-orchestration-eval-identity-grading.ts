// Checks for who a bot acts as (design v3): work on GitHub and Linear is done as the owner with `gh`
// and `orca linear`; where the bot was woken it speaks only through `orca bot reply` or its final
// answer. bot-orchestration-eval-grading.test.ts runs each against deliberately wrong traces.
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import { ConnectorReview } from '../../shared/connector-review-contract'
import { linearTeam } from '../bot-automation-eval/bot-automation-eval-linear'
import type { EvalRecordedWrite, EvalTurnOutcome } from './bot-orchestration-eval-conversation'
import { writes, type TurnCheck } from './bot-orchestration-eval-grading'

/** What `orca bot reply` records: a note, a reaction, or a review's line notes, where the bot was woken. */
export const BOT_REPLY_METHOD = 'connector.reply'

// gh writes that say something on a thread, as opposed to edits (labels, assignees, state).
const GH_SPEAKS = ['gh.issue.comment', 'gh.pr.comment', 'gh.pr.review']

const ghWrites = (turn: EvalTurnOutcome) =>
  turn.writes.filter((write) => write.method.startsWith('gh.'))

/** The write lands on owner/repo#number. */
function on(write: EvalRecordedWrite, place: string): boolean {
  const [repo, number] = place.split('#')
  return (
    String(write.params.repo ?? '').toLowerCase() === repo!.toLowerCase() &&
    Number(write.params.number) === Number(number)
  )
}

const bodyOf = (write: EvalRecordedWrite) => String(write.params.body ?? '')

/** The bot's `gh` did this (gh.issue.edit, gh.issue.comment, ...) on owner/repo#number, and what
 *  it wrote carries each fact. */
export function ghDoes(method: string, place: string, ...facts: RegExp[]): TurnCheck {
  return (turn) => {
    const done = writes(turn, method).filter((write) => on(write, place))
    if (!done.length) {
      return [`no ${method} on ${place}`]
    }
    return facts
      .filter((fact) => !done.some((write) => fact.test(bodyOf(write))))
      .map((fact) => `the ${method} on ${place} leaves out ${fact}`)
  }
}

/** Labels and assignees the bot's `gh` added on owner/repo#number, however many edits it took. */
export function ghEdits(
  place: string,
  expected: { labels?: string[]; assignees?: string[] }
): TurnCheck {
  return (turn) => {
    const edits = turn.writes.filter(
      (write) =>
        (write.method === 'gh.issue.edit' || write.method === 'gh.pr.edit') && on(write, place)
    )
    // An edit through `gh api` names what it adds only in its fields.
    const added = (key: 'addLabels' | 'addAssignees', name: string) =>
      edits.some((write) => {
        const value = write.params[key]
        const argv = write.params.argv
        return (
          (Array.isArray(value) && value.some((entry) => String(entry).toLowerCase() === name)) ||
          (Array.isArray(argv) && argv[0] === 'api' && argv.join(' ').toLowerCase().includes(name))
        )
      })
    return [
      ...(expected.labels ?? [])
        .filter((label) => !added('addLabels', label.toLowerCase()))
        .map((label) => `did not label ${place} ${label}`),
      ...(expected.assignees ?? [])
        .filter((login) => !added('addAssignees', login.toLowerCase()))
        .map((login) => `did not assign ${place} to ${login}`)
    ]
  }
}

/** Nothing said on the place that woke the bot except through `orca bot reply` and its final
 *  answer: no gh comment or review there, no `orca linear comment add` on that issue. */
export function speaksOnlyAsItselfOn(place: string): TurnCheck {
  return (turn) => [
    ...ghWrites(turn)
      .filter((write) => GH_SPEAKS.includes(write.method) && on(write, place))
      .map((write) => `${write.method} on ${place}, where it was woken`),
    ...(turn.commands.some(
      (argv) =>
        argv[0] === 'linear' &&
        argv[1] === 'comment' &&
        argv.some((arg) => arg.toUpperCase() === place.toUpperCase())
    )
      ? [`ran \`orca linear comment\` on ${place}, where it was woken`]
      : [])
  ]
}

/** Something reached the place that woke the bot: a final answer, or an `orca bot reply`. */
export const answersWhereWoken: TurnCheck = (turn) =>
  !isQuietBotResult(turn.reply) && turn.reply.trim()
    ? []
    : writes(turn, BOT_REPLY_METHOD).length
      ? []
      : ['nothing reached the conversation that woke it']

/** The line notes a reply carried, as `--note` sends them (connector-review-contract.ts). */
function notesOf(write: EvalRecordedWrite): { path: string }[] {
  const parsed = ConnectorReview.safeParse(write.params.review)
  return parsed.success ? parsed.data.comments : []
}

/** The review on the pull request that woke the bot is `orca bot reply` line notes, one on this file. */
export function notesWhereWoken(path: string): TurnCheck {
  return (turn) => {
    const notes = writes(turn, BOT_REPLY_METHOD).flatMap(notesOf)
    if (!notes.length) {
      return ['left no line notes with `orca bot reply --note`']
    }
    return notes.some((note) => note.path.endsWith(path)) ? [] : [`no line note on ${path}`]
  }
}

/** A review of a pull request the bot wasn't woken on: a comment review with the owner's `gh`,
 *  never an approval or change request, carrying each fact. */
export function commentReviews(place: string, ...facts: RegExp[]): TurnCheck {
  return (turn) => {
    const reviews = writes(turn, 'gh.pr.review').filter((write) => on(write, place))
    const verdicts = reviews.filter(
      (write) => write.params.event && write.params.event !== 'comment'
    )
    const said = [
      ...reviews,
      ...turn.writes.filter((write) => write.method === 'gh.pr.comment' && on(write, place))
    ]
    return [
      ...(said.length ? [] : [`no review or comment on ${place} with gh`]),
      ...verdicts.map(
        (write) => `${String(write.params.event)} on ${place}; only a comment review`
      ),
      ...facts
        .filter((fact) => said.length && !said.some((write) => fact.test(bodyOf(write))))
        .map((fact) => `the review leaves out ${fact}`),
      ...(writes(turn, BOT_REPLY_METHOD).length ? ['used `orca bot reply` away from the wake'] : [])
    ]
  }
}

/** A comment written for someone other than the owner ends with who asked and through which bot. */
export function tagsAsker(place: string, asker: string, bot: string): TurnCheck {
  return ghDoes(
    'gh.issue.comment',
    place,
    new RegExp(`asked by ${asker}\\b[^\\n]*\\bvia ${bot}`, 'i')
  )
}

// Everything a bot writes in words: gh and orca linear bodies, Slack posts and replies.
const WORDED = ['gh.issue.comment', 'gh.pr.comment', 'gh.pr.review', 'linear.issueAddComment']

/** No "asked by" line where it doesn't belong: anything the owner asked for, and Slack always. */
export const tagsNoAsker: TurnCheck = (turn) =>
  turn.writes
    .filter((write) => WORDED.includes(write.method) || write.method.startsWith('connector.'))
    .filter((write) => /asked by\b/i.test(JSON.stringify(write.params)))
    .map((write) => `${write.method} carries an "asked by" line`)

/** Linear changes go through `orca linear` as the owner: never a removed connector verb, and never
 *  the owner's separate `linear` CLI. */
export const worksAsOwner: TurnCheck = (turn) => [
  ...(turn.commands.some((argv) => argv[0] === 'connector')
    ? ['ran a removed `orca connector` verb']
    : []),
  ...(turn.ownerTools.includes('linear') ? ["ran the owner's `linear` CLI"] : [])
]

/** An `orca linear status set` left the issue in this state. */
export function linearMovesTo(id: string, state: string): TurnCheck {
  return (turn) => {
    const sets = writes(turn, 'linear.issueSetState').filter(
      (write) => String(write.params.input ?? '').toUpperCase() === id.toUpperCase()
    )
    const ended = sets.flatMap((write) =>
      write.result && 'state' in write.result && typeof write.result.state === 'string'
        ? [write.result.state]
        : []
    )
    return ended.at(-1) === state
      ? []
      : [`left ${id} in ${ended.at(-1) ?? 'an unknown state'}, not ${state}`]
  }
}

/** An `orca linear create` filed an issue in the team with this key (named any way the stand-in
 *  reads it), carrying each fact. */
export function linearFiles(team: string, ...facts: RegExp[]): TurnCheck {
  return (turn) => {
    const filed = writes(turn, 'linear.issueCreate').filter((write) =>
      [write.params.teamInput, write.params.teamKey].some(
        (value) => linearTeam(String(value ?? ''))?.key === team
      )
    )
    if (!filed.length) {
      return [`filed no issue in ${team}`]
    }
    const sent = filed.map(
      (write) => `${String(write.params.title)} ${String(write.params.body ?? '')}`
    )
    return facts
      .filter((fact) => !sent.some((text) => fact.test(text)))
      .map((fact) => `the new issue leaves out ${fact}`)
  }
}

/** An `orca linear comment add` on the issue, carrying each fact. */
export function linearComments(id: string, ...facts: RegExp[]): TurnCheck {
  return (turn) => {
    const added = writes(turn, 'linear.issueAddComment').filter(
      (write) => String(write.params.input ?? '').toUpperCase() === id.toUpperCase()
    )
    if (!added.length) {
      return [`no \`orca linear comment add\` on ${id}`]
    }
    return facts
      .filter((fact) => !added.some((write) => fact.test(bodyOf(write))))
      .map((fact) => `the comment on ${id} leaves out ${fact}`)
  }
}

// What getting around a signed-out tool looks like: raw API calls, a token, or signing in itself.
const WORKAROUND =
  /\bcurl\b|api\.github\.com|GH_TOKEN|GITHUB_TOKEN|auth login --with-token|api\.linear\.app/

/** With the tool signed out, the bot changed nothing anywhere, worked around nothing and asked for no
 *  token: it tells the owner the one line. */
export function reportsGap(line: RegExp, what: string): TurnCheck {
  return (turn) => [
    ...(line.test(turn.reply) ? [] : [`never told the owner ${what}`]),
    ...turn.writes
      .filter((write) => write.method !== BOT_REPLY_METHOD)
      .map((write) => `wrote ${write.method} anyway`),
    ...(turn.shell.some((command) => WORKAROUND.test(command))
      ? ['worked around the sign-in']
      : []),
    ...(/\b(personal access token|paste (a|your) token|send me (a|your) token)\b/i.test(turn.reply)
      ? ['asked for a token']
      : [])
  ]
}
