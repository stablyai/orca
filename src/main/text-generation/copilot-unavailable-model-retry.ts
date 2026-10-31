import { findOptionOccurrence } from '../../shared/command-option-occurrence'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'

const UNAVAILABLE_MODEL_STDERR = /Model "[^"]*" from --model flag is not available/
const PROMPT_VALUE_OPTIONS = ['--prompt', '-p']

function withoutOption(args: string[], aliases: readonly string[]): string[] {
  let remaining = args
  for (;;) {
    const option = findOptionOccurrence(remaining, aliases, true, PROMPT_VALUE_OPTIONS)
    if (!option) {
      return remaining
    }
    remaining = [
      ...remaining.slice(0, option.index),
      ...remaining.slice(option.index + option.consumed)
    ]
  }
}

/** Copilot rejects models the account's plan or org policy hides; rerun once on Copilot's own default model. */
export function copilotUnavailableModelRetryPlan(
  plan: CommitMessagePlan,
  stderr: string
): CommitMessagePlan | null {
  // The rejection happens before a model turn starts, so the retry cannot repeat work.
  if (!UNAVAILABLE_MODEL_STDERR.test(stderr)) {
    return null
  }
  const withoutModel = withoutOption(plan.args, ['--model'])
  if (withoutModel.length === plan.args.length) {
    return null
  }
  // The effort level belonged to the rejected model.
  return { ...plan, args: withoutOption(withoutModel, ['--effort', '--reasoning-effort']) }
}
