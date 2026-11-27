import { describe, expect, it } from 'vitest'
import { codexUnavailableModelRetryPlan } from './codex-unavailable-model-retry'

const BASE_ARGS = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only']
// Verbatim `codex exec` 0.165.0 refusal on a ChatGPT login.
const refused = (model: string) => ({
  label: 'Codex',
  exitCode: 1,
  stdout: '',
  stderr: `Reading prompt from stdin...\nOpenAI Codex v0.165.0\nERROR: The '${model}' model is not supported when using Codex with a ChatGPT account.`
})
const plan = (args: string[]) => ({
  binary: 'codex',
  args,
  stdinPayload: 'Name it.',
  label: 'Codex'
})

describe('codexUnavailableModelRetryPlan', () => {
  it('names and drops the model Codex was actually sent', () => {
    // Recipe args replaced Orca's --model, so Codex was sent gpt-5.4-mini, not the resolved gpt-5.5.
    const userModel = plan([
      ...BASE_ARGS,
      '-c',
      'model="gpt-5.4-mini"',
      '-c',
      'model_reasoning_effort=low'
    ])
    const retry = codexUnavailableModelRetryPlan(userModel, {}, refused('gpt-5.4-mini'))
    expect(retry?.refusedModel).toBe('gpt-5.4-mini')
    expect(retry?.plan.args).toEqual([...BASE_ARGS, '-c', 'model_reasoning_effort=low'])

    const orcaModel = plan([...BASE_ARGS, '--model', 'gpt-5.5', '-c', 'model_reasoning_effort=low'])
    const orcaRetry = codexUnavailableModelRetryPlan(
      orcaModel,
      { thinkingLevel: 'low' },
      refused('gpt-5.5')
    )
    expect(orcaRetry?.refusedModel).toBe('gpt-5.5')
    expect(orcaRetry?.plan.args).toEqual(BASE_ARGS)

    // Recipe effort after the recipe's model survives even when it equals Orca's level.
    const both = plan([
      ...BASE_ARGS,
      '--model',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort=low',
      '-c',
      'model=gpt-5.4-mini',
      '-c',
      'model_reasoning_effort=low'
    ])
    expect(
      codexUnavailableModelRetryPlan(both, { thinkingLevel: 'low' }, refused('gpt-5.5'))?.plan.args
    ).toEqual([...BASE_ARGS, '-c', 'model_reasoning_effort=low'])

    // A refusal of another model, or a run that sent none, is not blamed on anything.
    expect(codexUnavailableModelRetryPlan(orcaModel, {}, refused('gpt-5.4-mini'))).toBeNull()
    expect(codexUnavailableModelRetryPlan(plan(BASE_ARGS), {}, refused('gpt-5.5'))).toBeNull()
  })
})
