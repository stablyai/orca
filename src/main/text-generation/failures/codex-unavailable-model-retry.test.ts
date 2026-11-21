import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generationArgumentText } from '../../../shared/source-control/ai/generation/generation-argument'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control/ai/source-control-ai-operation-resolution'
import type { InternalTextGenerationResult } from '../source-control-text-generation-types'
import { runGenerationRequest } from '../agent-generation-request'
import { runLocalPlanForAgent } from '../execution/source-control-local-generation'
import { codexUnavailableModelRetryPlan } from './codex-unavailable-model-retry'

vi.mock('../execution/source-control-local-generation', () => ({
  runLocalPlanForAgent: vi.fn()
}))

const runLocalPlan = vi.mocked(runLocalPlanForAgent)

const MODEL = 'gpt-5.6-terra'
const RETRIES = [1, 2, 3, 4, 5].map((n) => `ERROR: Reconnecting... ${n}/5`)
const BASE_ARGS = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only']
const PLAN = {
  binary: 'codex',
  args: [...BASE_ARGS, '--model', MODEL, '-c', 'model_reasoning_effort=low'],
  stdinPayload: 'Name this branch.',
  label: 'Codex'
}

// `codex exec` 0.169.1 stderr; the 404, model_not_found and 503 lines are verbatim from runs against a local gateway.
function codexStderr(...errors: string[]): string {
  return [
    'OpenAI Codex v0.169.1',
    '--------',
    `model: ${MODEL}`,
    'provider: gateway',
    '--------',
    ...errors,
    ...errors.slice(-1)
  ].join('\n')
}

function failure(stderr: string, exitCode: number | null = 1) {
  return { label: 'Codex', exitCode, stdout: '', stderr }
}

function failedRun(stderr: string): InternalTextGenerationResult {
  return { success: false, error: 'Codex failed.', failureOutput: failure(stderr) }
}

const UNAVAILABLE_STDERR = codexStderr(
  ...RETRIES,
  `ERROR: unexpected status 404 Not Found: model ${MODEL} not found, url: http://127.0.0.1/v1/responses`
)
const UNAVAILABLE = failedRun(UNAVAILABLE_STDERR)
const SUCCESS: InternalTextGenerationResult = { success: true, rawOutput: 'fix-login' }

function spawnedArgs(): string[][] {
  return runLocalPlan.mock.calls.map(([input]) => input.plan.args.map(generationArgumentText))
}

function generate(params: Partial<ResolvedSourceControlAiGenerationParams>) {
  return runGenerationRequest({
    params: { agentId: 'codex', model: MODEL, thinkingLevel: 'low', ...params },
    prompt: 'Name this branch.',
    target: { kind: 'local', cwd: '/repo' },
    operation: 'branch-name',
    spawnAgent: vi.fn()
  })
}

function retriesFor(stderr: string, exitCode: number | null = 1): boolean {
  return (
    codexUnavailableModelRetryPlan(
      PLAN,
      { model: MODEL, thinkingLevel: 'low', usesOrcaDefaultModel: true },
      failure(stderr, exitCode)
    ) !== null
  )
}

beforeEach(() => {
  runLocalPlan.mockReset()
})

describe('Codex model-unavailable failures', () => {
  it.each([
    ['a 404 naming the model', UNAVAILABLE_STDERR],
    [
      'model_not_found with a message',
      codexStderr(`ERROR: The model \`${MODEL}\` does not exist or you do not have access to it.`)
    ],
    ['model_not_found without a message', codexStderr('ERROR: model_not_found')]
  ])('reruns on %s', (_name, stderr) => {
    expect(retriesFor(stderr)).toBe(true)
  })

  it.each([
    [
      'a 404 that does not name the model',
      codexStderr(
        ...RETRIES,
        'ERROR: unexpected status 404 Not Found: no such route, url: http://127.0.0.1/v1/responses'
      )
    ],
    [
      'a rate limit naming the model',
      codexStderr(
        `ERROR: rate limit exceeded: Rate limit reached for ${MODEL} in organization org-x on tokens per min`
      )
    ],
    [
      'a provider outage',
      codexStderr(
        ...RETRIES,
        'ERROR: unexpected status 503 Service Unavailable: upstream unavailable, url: http://127.0.0.1/v1/responses'
      )
    ],
    ['retries cut short', RETRIES.join('\n')],
    [
      'an earlier non-fatal not-found before an outage',
      codexStderr(
        `ERROR: unexpected status 404 Not Found: model ${MODEL} not found`,
        'ERROR: unexpected status 503 Service Unavailable: upstream unavailable'
      )
    ],
    [
      'another model not found',
      codexStderr(
        'ERROR: The model `gpt-5.6-terra-mini` does not exist or you do not have access to it.'
      )
    ]
  ])('does not rerun on %s', (_name, stderr) => {
    expect(retriesFor(stderr)).toBe(false)
  })

  it('does not rerun a killed process', () => {
    expect(retriesFor(codexStderr('ERROR: model_not_found'), null)).toBe(false)
  })
})

describe('Codex rerun when the forced default model is unavailable', () => {
  it('reruns once without only the model and effort Orca passed', async () => {
    runLocalPlan.mockResolvedValueOnce(UNAVAILABLE).mockResolvedValueOnce(SUCCESS)

    await expect(
      generate({
        usesOrcaDefaultModel: true,
        agentArgs: '-c model_verbosity=low -c model_reasoning_effort=high'
      })
    ).resolves.toEqual(SUCCESS)

    const userArgs = ['-c', 'model_verbosity=low', '-c', 'model_reasoning_effort=high']
    expect(spawnedArgs()).toEqual([
      [...BASE_ARGS, '--model', MODEL, '-c', 'model_reasoning_effort=low', ...userArgs],
      [...BASE_ARGS, ...userArgs]
    ])
  })

  it('surfaces the failure of a model the user picked', async () => {
    runLocalPlan.mockResolvedValueOnce(UNAVAILABLE)

    await expect(generate({})).resolves.toEqual(UNAVAILABLE)
    expect(runLocalPlan).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['recipe -m', { agentArgs: '-m gpt-5.6-terra-mini' }],
    ['recipe -c model=', { agentArgs: '-c model=gpt-5.6-terra-mini' }],
    ['command override --model', { agentCommandOverride: `codex --model ${MODEL}` }]
  ])('keeps a model passed by %s', async (_name, userParams) => {
    runLocalPlan.mockResolvedValueOnce(UNAVAILABLE)

    await expect(generate({ usesOrcaDefaultModel: true, ...userParams })).resolves.toEqual(
      UNAVAILABLE
    )
    expect(runLocalPlan).toHaveBeenCalledTimes(1)
  })

  it('spawns once when the run succeeds', async () => {
    runLocalPlan.mockResolvedValueOnce(SUCCESS)

    await expect(generate({ usesOrcaDefaultModel: true })).resolves.toEqual(SUCCESS)
    expect(runLocalPlan).toHaveBeenCalledTimes(1)
  })
})
