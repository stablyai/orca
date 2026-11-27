import {
  generationOptionTokens,
  type GenerationArgument
} from '../../../shared/source-control/ai/generation/generation-argument'
import {
  getCommitMessageAgentSpec,
  type CommitMessageAgentSpec
} from '../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { stripAnsiControlSequences } from '../../../shared/source-control/ai/generation/commit-message-agent-output'
import { findOptionOccurrence } from '../../../shared/cli/command-option-occurrence'
import type { CommitMessagePlan } from '../../../shared/source-control/ai/generation/commit-message-plan'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { escapeRegex } from '../../../shared/text/regex-escaping'
import type { AgentGenerationFailureOutput } from './agent-failure-output'

const UNAVAILABLE_MODEL_PHRASE =
  /\b(?:does not exist|not found|not supported|unknown model|invalid model|not a valid model)\b/i

type RetryParams = Pick<ResolvedSourceControlAiGenerationParams, 'thinkingLevel'>

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

type SentModel = { model: string; spans: { index: number; consumed: number }[] }

/** The model a Codex plan sends (`--model`/`-m` beats `-c model=`, the last of each wins) and every span passing one. */
function sentCodexModel(tokens: readonly string[], spec: CommitMessageAgentSpec): SentModel | null {
  const valueOptions = [...spec.modelFlag, ...spec.effortFlag].flatMap((flag) => flag.aliases)
  const spans: SentModel['spans'] = []
  let model: string | undefined
  for (const flag of spec.modelFlag) {
    let flagModel: string | undefined
    let found = findOptionOccurrence(tokens, flag.aliases, true, valueOptions)
    while (found) {
      const value = found.value ?? ''
      const configured = flag.configKey ? /^\s*([\w.-]+)\s*=(.*)$/.exec(value) : null
      if (!flag.configKey || configured?.[1] === flag.configKey) {
        spans.push({ index: found.index, consumed: found.consumed })
        flagModel = (configured ? configured[2] : value).trim().replace(/^(["'])(.*)\1$/, '$2')
      }
      found = findOptionOccurrence(
        tokens,
        flag.aliases,
        true,
        valueOptions,
        found.index + found.consumed
      )
    }
    model ??= flagModel
  }
  return model ? { model, spans } : null
}

export type CodexUnavailableModelRetry<T extends GenerationArgument> = {
  plan: CommitMessagePlan<T>
  /** The model Codex refused; the retry runs Codex's own default for the signed-in account. */
  refusedModel: string
}

/** Codex refused the model it was sent (a stale pick, a retired default, another account's model): rerun once on Codex's own default. */
export function codexUnavailableModelRetryPlan<T extends GenerationArgument>(
  plan: CommitMessagePlan<T>,
  params: RetryParams,
  failure: AgentGenerationFailureOutput | undefined
): CodexUnavailableModelRetry<T> | null {
  const spec = getCommitMessageAgentSpec('codex')
  const tokens = generationOptionTokens(plan.args)
  const sent = spec ? sentCodexModel(tokens, spec) : null
  if (!sent || !isModelUnavailableFailure(sent.model, failure)) {
    return null
  }
  // Generated args precede recipe args, so Orca's effort is the plan's first effort override.
  const firstEffort = tokens.findIndex(
    (token, index) => token === '-c' && tokens[index + 1]?.startsWith('model_reasoning_effort=')
  )
  const orcaEffort =
    params.thinkingLevel !== undefined &&
    tokens[firstEffort + 1] === `model_reasoning_effort=${params.thinkingLevel}`
      ? firstEffort
      : -1
  const removed = new Set<number>()
  for (const span of sent.spans) {
    for (let offset = 0; offset < span.consumed; offset += 1) {
      removed.add(span.index + offset)
    }
    // Orca's effort follows its own --model and may not fit Codex's default; recipe effort is kept.
    if (orcaEffort >= 0 && span.index + span.consumed === orcaEffort) {
      removed.add(orcaEffort).add(orcaEffort + 1)
    }
  }
  return {
    plan: { ...plan, args: plan.args.filter((_argument, index) => !removed.has(index)) },
    refusedModel: sent.model
  }
}
