// `automations watch-pr`: one wait on everything that can need a pull request's next step, written
// as the `automations create` flags it stands for.
import { getPresentStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { REPEATED_FLAG_SEPARATOR } from '../arguments/args'
import { RuntimeClientError } from '../runtime/connection/types'
import { WAIT_MAX_DEADLINE_MS } from '../../shared/automation-once'

type Flags = Map<string, string | boolean>

/** Without --by or --for, a watch wakes this long after it is made, whatever has happened. */
export const WATCH_PR_DEFAULT_MS = 2 * 60 * 60 * 1000

/** What a watch hears besides CI. */
const WATCH_PR_EVENTS = [
  'pr_conflicted',
  'pr_merged',
  'pr_closed',
  'review',
  'review_comment',
  'comment'
] as const

/** CI's result: one ci_finished where the host's Orca Cloud sends it, else passed and failed (the
 *  deadline still catches what neither hears, such as a cancelled check on an older cloud). */
function ciEvents(ciFinished: boolean): readonly string[] {
  return ciFinished ? ['ci_finished'] : ['ci_passed', 'ci_failed']
}

/** Named here too, since a caller's prompt may not say which pull request it is. */
const deadlineLine = (pr: string) =>
  `If Orca says the deadline came first, no event came in time: read ${pr} fresh with gh (state, mergeable, checks) before acting.`

/** owner/repo#n, from that or a link to the pull request or one of its tabs. */
export function parseWatchedPr(raw: string): string {
  const trimmed = raw.trim()
  const short = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/.exec(trimmed)
  const link =
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|checks|commits))?\/?(?:[?#].*)?$/i.exec(
      trimmed
    )
  const match = short ?? link
  if (!match) {
    throw new RuntimeClientError(
      'invalid_argument',
      'watch-pr takes one pull request: owner/repo#123 or its https://github.com/owner/repo/pull/123 link'
    )
  }
  return `${match[1]}/${match[2]}#${match[3]}`
}

/** Milliseconds in "45m", "2h" or "1h30m", up to a wait's furthest deadline. */
export function parseWatchDuration(raw: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/i.exec(raw.trim())
  const ms = (Number(match?.[1] ?? 0) * 60 + Number(match?.[2] ?? 0)) * 60 * 1000
  if (!match || !Number.isFinite(ms) || ms <= 0 || ms > WAIT_MAX_DEADLINE_MS) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--for takes a length like 45m, 2h or 1h30m, up to a year'
    )
  }
  return ms
}

/** The ISO deadline: --by as given, now plus --for, or now plus the default. */
function watchDeadline(flags: Flags, now: number): string {
  const by = getPresentStringFlag(flags, 'by')
  const length = getPresentStringFlag(flags, 'for')
  if (by !== undefined && length !== undefined) {
    throw new RuntimeClientError('invalid_argument', 'Use --by or --for, not both')
  }
  if (by !== undefined) {
    return by
  }
  const ms = length === undefined ? WATCH_PR_DEFAULT_MS : parseWatchDuration(length)
  return new Date(now + ms).toISOString()
}

/** The create flags a watch stands for: a --once wait with a deadline on each of its events.
 *  ciFinished: the bot's Orca Cloud sends github.ci_finished. */
export function watchPrCreateFlags(flags: Flags, now: number, ciFinished: boolean): Flags {
  const pr = parseWatchedPr(getRequiredStringFlag(flags, 'pr'))
  const asked = getPresentStringFlag(flags, 'prompt')
  // The default already reads it fresh, so only a caller's own prompt gets the deadline line.
  const prompt = asked
    ? `${asked}\n\n${deadlineLine(pr)}`
    : `Pull request ${pr}: whether an event or the deadline woke you, read it fresh with gh (state, mergeable, checks, unresolved review threads), then say what it needs next.`
  const created = new Map(flags)
  for (const own of ['pr', 'for']) {
    created.delete(own)
  }
  created.set('name', getPresentStringFlag(flags, 'name') ?? `PR ${pr}`)
  created.set('prompt', prompt)
  created.set(
    'on',
    [...ciEvents(ciFinished), ...WATCH_PR_EVENTS]
      .map((event) => `github.${event} subject=${pr}`)
      .join(REPEATED_FLAG_SEPARATOR)
  )
  created.set('once', true)
  created.set('by', watchDeadline(flags, now))
  return created
}
