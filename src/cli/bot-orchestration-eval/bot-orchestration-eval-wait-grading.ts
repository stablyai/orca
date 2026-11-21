// Grading of the waits a bot makes: a pull request watch only when asked, carrying its fix rule.
import { writes, type TurnCheck } from './bot-orchestration-eval-grading'

const PR_WAIT_EVENTS = [
  'github.ci_passed',
  'github.ci_failed',
  'github.pr_conflicted',
  'github.pr_merged',
  'github.pr_closed',
  'github.review',
  'github.review_comment',
  'github.comment'
]
// "fix attempt 1 of 2", "2 fix attempts", "two rounds": the rule the wait's prompt must carry.
const TWO_ATTEMPTS =
  /\b(of 2|2 (fix )?(attempts|rounds|tries)|two (fix )?(attempts|rounds|tries))\b/i

/** Asked to watch a pull request: exactly one wait (--once) on that pull request alone, for its CI
 *  (passing too, so it can say the pull request is ready) or reviews, whose prompt carries the
 *  2-attempt rule. */
export function waitsOnPr(subject: RegExp): TurnCheck {
  return (turn) => {
    const waits = writes(turn, 'automation.create').filter((write) => write.params.once != null)
    if (waits.length !== 1) {
      return [`made ${waits.length} waits on the pull request, not one`]
    }
    const { on, prompt } = waits[0]!.params
    const triggers = (Array.isArray(on) ? on : []).filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null
    )
    const onPr = triggers.filter(
      (trigger) =>
        PR_WAIT_EVENTS.includes(`${String(trigger.source)}.${String(trigger.event)}`) &&
        subject.test(String(trigger.subject ?? ''))
    )
    return [
      ...(onPr.some((trigger) => trigger.event === 'ci_failed' || trigger.event === 'review')
        ? []
        : ['the wait hears neither CI failures nor reviews on the pull request']),
      ...(onPr.some((trigger) => trigger.event === 'ci_passed')
        ? []
        : ['the wait never hears the pull request turn green']),
      ...(onPr.length === triggers.length ? [] : ['the wait listens beyond the pull request']),
      ...(TWO_ATTEMPTS.test(String(prompt ?? ''))
        ? []
        : ["the wait's prompt does not carry the 2-attempt rule"])
    ]
  }
}

/** Nobody asked for a watch or an automation, so the bot makes none. */
export const makesNoAutomation: TurnCheck = (turn) =>
  writes(turn, 'automation.create').length > 0 ? ['made an automation nobody asked for'] : []
