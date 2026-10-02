import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type AgentPromptActivity,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'

const LAUNCH_STARTED_AT = 1_000

function activity(overrides: Partial<AgentPromptActivity> = {}): AgentPromptActivity {
  return {
    generation: 1,
    permissionSequence: 0,
    workingSequence: 0,
    explicitWorkingStartedAt: null,
    explicitPromptStartedAt: null,
    outputSequence: 0,
    status: null,
    ...overrides
  }
}

async function verifyLaunch(next: AgentPromptActivity): Promise<string> {
  vi.useFakeTimers()
  let current = activity()
  const outcome = verifyAgentPromptSubmission({
    baseline: { ...current, explicitPromptStartedAt: LAUNCH_STARTED_AT },
    readActivity: () => current,
    explicitPromptOnly: true,
    timeoutMs: 500
  }).then(
    () => 'observed',
    (error: Error) => error.message
  )
  current = next
  await vi.advanceTimersByTimeAsync(600)
  return outcome
}

describe('launch turn-start verification (explicit prompt only)', () => {
  afterEach(() => vi.useRealTimers())

  it('does not count a spinner-title working edge with no hook', async () => {
    expect(
      await verifyLaunch(activity({ workingSequence: 1, status: 'working', outputSequence: 90 }))
    ).toBe('agent_prompt_stalled')
  })

  it('does not count a hook turn that carried no prompt, such as a SessionStart', async () => {
    expect(
      await verifyLaunch(activity({ explicitWorkingStartedAt: 2_000, status: 'working' }))
    ).toBe('agent_prompt_stalled')
  })

  it('does not count a prompt that started before the launch', async () => {
    expect(
      await verifyLaunch(
        activity({
          explicitWorkingStartedAt: 900,
          explicitPromptStartedAt: 900,
          status: 'working'
        })
      )
    ).toBe('agent_prompt_stalled')
  })

  it('counts a prompt-carrying hook turn after the launch', async () => {
    expect(
      await verifyLaunch(
        activity({
          explicitWorkingStartedAt: 2_000,
          explicitPromptStartedAt: 2_000,
          status: 'working'
        })
      )
    ).toBe('observed')
  })

  it('reports a blocking dialog as permission', async () => {
    expect(await verifyLaunch(activity({ status: 'permission' }))).toBe('agent_prompt_blocked')
  })
})
