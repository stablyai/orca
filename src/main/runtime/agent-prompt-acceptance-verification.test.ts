import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS,
  type AgentPromptActivity,
  requiresAgentPromptAcceptance,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'

function activity(overrides: Partial<AgentPromptActivity> = {}): AgentPromptActivity {
  return {
    generation: 1,
    permissionSequence: 0,
    workingSequence: 0,
    explicitWorkingStartedAt: null,
    outputSequence: 0,
    status: null,
    promptAcceptedAt: null,
    requiresPromptAcceptance: true,
    ...overrides
  }
}

// What a first Codex launch looks like when the Enter is lost: its startup spinner title raises a
// working edge, and no hook fires at all, because Codex runs SessionStart inside the first turn.
const STARTUP_SPINNER_ONLY = { workingSequence: 1, status: 'working' as const }

describe('agent prompt acceptance verification', () => {
  afterEach(() => vi.useRealTimers())

  it('does not read a first-launch startup spinner as a turn when hooks are expected', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      allowOutputEvidence: false,
      timeoutMs: AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS
    })
    const stalled = expect(verification).rejects.toThrow('agent_prompt_stalled')

    current = activity(STARTUP_SPINNER_ONLY)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS)

    await stalled
  })

  it('does not read a session-start working row as a turn when hooks are expected', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      timeoutMs: 1_000
    })
    const stalled = expect(verification).rejects.toThrow('agent_prompt_stalled')

    current = activity({ status: 'working', explicitWorkingStartedAt: Date.now() + 10 })
    await vi.advanceTimersByTimeAsync(1_000)

    await stalled
  })

  it("accepts the agent's own prompt acceptance recorded after the baseline", async () => {
    vi.useFakeTimers()
    let current = activity({ promptAcceptedAt: 100 })
    const acceptTurnStart = vi.fn(() => true)
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      acceptTurnStart,
      allowOutputEvidence: false
    })

    current = activity({ ...STARTUP_SPINNER_ONLY, promptAcceptedAt: 200 })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toEqual({ resubmitted: false })
    expect(acceptTurnStart).toHaveBeenCalledWith({ kind: 'accepted', acceptedAt: 200 })
  })

  it('keeps the working-edge rules for a Codex pane launched without Orca hooks', async () => {
    vi.useFakeTimers()
    let current = activity({ requiresPromptAcceptance: false })
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      allowOutputEvidence: false
    })

    current = activity({ ...STARTUP_SPINNER_ONLY, requiresPromptAcceptance: false })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toEqual({ resubmitted: false })
  })

  it('sends exactly one retry Enter when no turn is accepted by the retry delay', async () => {
    vi.useFakeTimers()
    let current = activity()
    const write = vi.fn(() => true)
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      resubmit: { afterMs: 1_200, write },
      timeoutMs: 10_000
    })

    await vi.advanceTimersByTimeAsync(1_150)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(write).toHaveBeenCalledTimes(1)

    current = activity({ promptAcceptedAt: 500 })
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(verification).resolves.toEqual({ resubmitted: true })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('sends no retry Enter once the first Enter was accepted', async () => {
    vi.useFakeTimers()
    let current = activity()
    const write = vi.fn(() => true)
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      resubmit: { afterMs: 1_200, write }
    })

    current = activity({ promptAcceptedAt: 500 })
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(verification).resolves.toEqual({ resubmitted: false })
    expect(write).not.toHaveBeenCalled()
  })

  it('sends no retry Enter while the agent shows a permission prompt', async () => {
    vi.useFakeTimers()
    let current = activity()
    const write = vi.fn(() => true)
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      resubmit: { afterMs: 1_200, write }
    })
    const blocked = expect(verification).rejects.toThrow('agent_prompt_blocked')

    current = activity({ status: 'permission' })
    await vi.advanceTimersByTimeAsync(2_000)

    await blocked
    expect(write).not.toHaveBeenCalled()
  })
})

describe('requiresAgentPromptAcceptance', () => {
  const launchedCodex = {
    launchAgent: 'codex' as const,
    foregroundAgent: 'codex' as const,
    launchToken: 'token',
    launchIncarnationId: 'inc-1',
    incarnationId: 'inc-1'
  }

  it('requires acceptance only from a Codex process Orca launched with its hooks', () => {
    expect(requiresAgentPromptAcceptance(launchedCodex)).toBe(true)
    expect(requiresAgentPromptAcceptance({ ...launchedCodex, foregroundAgent: null })).toBe(true)
    expect(requiresAgentPromptAcceptance({ ...launchedCodex, launchToken: null })).toBe(false)
    expect(requiresAgentPromptAcceptance({ ...launchedCodex, incarnationId: 'inc-2' })).toBe(false)
    expect(requiresAgentPromptAcceptance({ ...launchedCodex, foregroundAgent: 'claude' })).toBe(
      false
    )
    expect(
      requiresAgentPromptAcceptance({
        ...launchedCodex,
        launchAgent: 'claude',
        foregroundAgent: 'claude'
      })
    ).toBe(false)
    expect(requiresAgentPromptAcceptance(undefined)).toBe(false)
  })
})
