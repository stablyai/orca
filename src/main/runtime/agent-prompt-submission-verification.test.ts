import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  type AgentPromptActivity,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'

function activity(overrides: Partial<AgentPromptActivity> = {}): AgentPromptActivity {
  return {
    generation: 1,
    permissionSequence: 2,
    workingSequence: 4,
    status: 'idle',
    ...overrides
  }
}

describe('agent prompt submission verification', () => {
  afterEach(() => vi.useRealTimers())

  it('accepts an observed working transition', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    current = activity({ workingSequence: 5, status: 'working' })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toBeUndefined()
  })

  it('accepts a completed lifecycle transition between polls', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    current = activity({ workingSequence: 5 })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toBeUndefined()
  })

  it('does not accept an unrelated transition to a neutral title', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    current = activity({ status: null })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('reports stalled when no lifecycle transition occurs', async () => {
    vi.useFakeTimers()
    const current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('blocks when permission appears after submit', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_blocked')

    current = activity({ status: 'permission' })
    await vi.advanceTimersByTimeAsync(50)

    await rejected
  })

  it('blocks when permission appears and clears between polls', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_blocked')

    current = activity({ permissionSequence: 3 })
    await vi.advanceTimersByTimeAsync(50)

    await rejected
  })

  it('rejects an existing permission state', async () => {
    const current = activity({ status: 'permission' })

    await expect(
      verifyAgentPromptSubmission({ baseline: current, readActivity: () => current })
    ).rejects.toThrow('agent_prompt_blocked')
  })

  it('does not accept an unchanged working baseline', async () => {
    vi.useFakeTimers()
    const current = activity({ status: 'working' })
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('rejects a replaced terminal generation', async () => {
    const baseline = activity()

    await expect(
      verifyAgentPromptSubmission({
        baseline,
        readActivity: () => activity({ generation: 2 })
      })
    ).rejects.toThrow('terminal_handle_stale')
  })

  it('cancels while waiting for activity', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      signal: controller.signal
    })

    controller.abort()

    await expect(verification).rejects.toThrow('request_aborted')
  })
})
