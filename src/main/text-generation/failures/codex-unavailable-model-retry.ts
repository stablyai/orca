import {
  generationOptionTokens,
  type GenerationArgument
} from '../../../shared/source-control/ai/generation/generation-argument'
import {
  getCommitMessageAgentSpec,
  type CommitMessageAgentSpec
} from '../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { stripAnsiControlSequences } from '../../../shared/source-control/ai/generation/commit-message-agent-output'
import type { CommandTemplateBackslash } from '../../../shared/source-control/ai/generation/commit-message-prompt'
import { removeSourceControlAiArgumentFlag } from '../../../shared/source-control/ai/recipes/source-control-ai-argument-flags'
import { findOptionOccurrence } from '../../../shared/cli/command-option-occurrence'
import type { CommitMessagePlan } from '../../../shared/source-control/ai/generation/commit-message-plan'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { escapeRegex } from '../../../shared/text/regex-escaping'
import type { AgentGenerationFailureOutput } from './agent-failure-output'

const UNAVAILABLE_MODEL_PHRASE =
  /\b(?:does not exist|not found|not supported|unknown model|invalid model|not a valid model)\b/i

type RetryParams = Pick<
  ResolvedSourceControlAiGenerationParams,
  'model' | 'thinkingLevel' | 'usesOrcaDefaultModel' | 'agentArgs' | 'agentCommandOverride'
> & { backslash?: CommandTemplateBackslash }

function isModelUnavailableFailure(
  model: string,
  failure: AgentGenerationFailureOutput | undefined
): boolean {
  if (!failure?.exitCode) {
    return false
  }
  // `codex exec` prints the failed turn's error last, as `ERROR: <message>`; earlier lines can be non-fatal.
  const message = stripAnsiControlSequences(failure.stderr)
    .split(/\r?\n/)
    .map((line) => /^ERROR: (.+)$/.exec(line)?.[1])
    .findLast((line) => line !== undefined && !line.startsWith('Reconnecting...'))
  if (!message) {
    return false
  }
  // Codex's model_not_found error when the provider sent no message.
  if (message === 'model_not_found') {
    return true
  }
  // Any other error, a 404 included, must name the passed model so an unrelated 404 is not rerun.
  const namesModel = new RegExp(`(?<![\\w.-])${escapeRegex(model)}(?![\\w-]|\\.\\w)`)
  return namesModel.test(message) && UNAVAILABLE_MODEL_PHRASE.test(message)
}

function userArgsPassModel(params: RetryParams, spec: CommitMessageAgentSpec): boolean {
  return [params.agentArgs, params.agentCommandOverride].some((args) => {
    if (!args) {
      return false
    }
    const stripped = removeSourceControlAiArgumentFlag(args, spec, 'model', params.backslash)
    return stripped.unrecognized || stripped.agentArgs !== args
  })
}

/** Orca's built-in Codex default can be missing from a custom provider; rerun once on Codex's configured model. */
export function codexUnavailableModelRetryPlan<T extends GenerationArgument>(
  plan: CommitMessagePlan<T>,
  params: RetryParams,
  failure: AgentGenerationFailureOutput | undefined
): CommitMessagePlan<T> | null {
  const spec = getCommitMessageAgentSpec('codex')
  // A model the user picked, in settings or in recipe/override args, should fail visibly.
  if (
    !spec ||
    !params.usesOrcaDefaultModel ||
    !isModelUnavailableFailure(params.model, failure) ||
    userArgsPassModel(params, spec)
  ) {
    return null
  }
  const tokens = generationOptionTokens(plan.args)
  const model = findOptionOccurrence(tokens, ['--model'], true)
  if (!model || model.value !== params.model) {
    return null
  }
  // Codex's buildArgs puts Orca's effort right after its --model; recipe or override effort is kept.
  const modelEnd = model.index + model.consumed
  const orcaEffort =
    params.thinkingLevel !== undefined &&
    tokens[modelEnd] === '-c' &&
    tokens[modelEnd + 1] === `model_reasoning_effort=${params.thinkingLevel}`
  return {
    ...plan,
    args: [...plan.args.slice(0, model.index), ...plan.args.slice(modelEnd + (orcaEffort ? 2 : 0))]
  }
}
