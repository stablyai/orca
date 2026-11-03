import { describe, expect, it } from 'vitest'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { copilotUnavailableModelRetryPlan } from './copilot-unavailable-model-retry'

const rejection = 'Error: Model "gpt-5.4" from --model flag is not available.\n'
const plan: CommitMessagePlan = {
  binary: 'copilot',
  // The prompt quotes the rejection text and must survive argv editing.
  args: ['--prompt', rejection, '--silent', '--model', 'gpt-5.4', '--effort', 'low'],
  stdinPayload: null,
  label: 'GitHub Copilot'
}

function failure(overrides: { exitCode?: number | null; stdout?: string; stderr?: string }) {
  return { label: 'GitHub Copilot', exitCode: 1, stdout: '', stderr: rejection, ...overrides }
}

describe('copilotUnavailableModelRetryPlan', () => {
  it('drops the rejected model and its effort level', () => {
    expect(copilotUnavailableModelRetryPlan(plan, failure({}))?.args).toEqual([
      '--prompt',
      rejection,
      '--silent'
    ])
  })

  it('accepts the rejection line among other stderr lines', () => {
    const stderr = `Update available\r\n${rejection.replace('\n', '\r\n')}`
    expect(copilotUnavailableModelRetryPlan(plan, failure({ stderr }))).not.toBeNull()
  })

  it.each([
    ['no failure output', undefined],
    ['exit code 0', failure({ exitCode: 0 })],
    ['unknown exit code', failure({ exitCode: null })],
    ['model output before the failure', failure({ stdout: 'fix-login\n' })],
    ['a quoted rejection', failure({ stderr: `agent said: ${rejection}` })],
    [
      'a rejection of another model',
      failure({ stderr: 'Error: Model "gpt-5.5" from --model flag is not available.\n' })
    ]
  ])('does not retry with %s', (_name, output) => {
    expect(copilotUnavailableModelRetryPlan(plan, output)).toBeNull()
  })

  it('does not retry when the plan passes no model', () => {
    expect(
      copilotUnavailableModelRetryPlan({ ...plan, args: plan.args.slice(0, 3) }, failure({}))
    ).toBeNull()
  })
})
