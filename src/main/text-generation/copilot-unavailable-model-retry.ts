import {
  generationOptionTokens,
  type GenerationArgument
} from '../../shared/source-control/ai/generation/generation-argument'
import { findOptionOccurrence } from '../../shared/command-option-occurrence'
import type { CommitMessagePlan } from '../../shared/source-control/ai/generation/commit-message-plan'
import { escapeRegex } from '../../shared/string-utils'
import type { AgentGenerationFailureOutput } from './agent-failure-output'

const PROMPT_VALUE_OPTIONS = ['--prompt', '-p']

function withoutOption<T extends GenerationArgument>(args: T[], aliases: readonly string[]): T[] {
  let remaining = args
  for (;;) {
    const option = findOptionOccurrence(
      generationOptionTokens(remaining),
      aliases,
      true,
      PROMPT_VALUE_OPTIONS
    )
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
export function copilotUnavailableModelRetryPlan<T extends GenerationArgument>(
  plan: CommitMessagePlan<T>,
  failure: AgentGenerationFailureOutput | undefined
): CommitMessagePlan<T> | null {
  // The rejection exits nonzero before a model turn starts, so the retry cannot repeat work.
  if (
    !failure ||
    failure.exitCode === 0 ||
    failure.exitCode === null ||
    /\S/.test(failure.stdout)
  ) {
    return null
  }
  const model = findOptionOccurrence(
    generationOptionTokens(plan.args),
    ['--model'],
    true,
    PROMPT_VALUE_OPTIONS
  )?.value
  if (!model) {
    return null
  }
  // Match Copilot's own error line for the model we passed, not the text quoted elsewhere.
  const rejection = new RegExp(
    `^Error: Model "${escapeRegex(model)}" from --model flag is not available\\.?\\r?$`,
    'm'
  )
  if (!rejection.test(failure.stderr)) {
    return null
  }
  // The effort level belonged to the rejected model.
  return {
    ...plan,
    args: withoutOption(withoutOption(plan.args, ['--model']), ['--effort', '--reasoning-effort'])
  }
}
