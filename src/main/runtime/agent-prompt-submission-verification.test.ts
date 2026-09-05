import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_COMPOSER_CLEAR_CONFIRM_MS,
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS,
  AGENT_PROMPT_PENDING_COMPOSER_GRACE_MS,
  AGENT_PROMPT_STALLED_ERROR,
  AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS,
  type AgentPromptActivity,
  isAgentPromptStalledError,
  readAgentPromptWaitText,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'
import type { AgentPromptComposerVerdict } from './agent-prompt-composer-pending'

function activity(overrides: Partial<AgentPromptActivity> = {}): AgentPromptActivity {
  return {
    generation: 1,
    permissionSequence: 2,
    workingSequence: 4,
    explicitWorkingStartedAt: null,
    outputSequence: 7,
    status: 'idle',
    ...overrides
  }
}

describe('agent prompt submission verification', () => {
  afterEach(() => vi.useRealTimers())

  it('reuses wait text while the PTY output sequence is unchanged', () => {
    const cache: { outputSequence?: number; waitText?: string } = {}
    const readWaitText = vi.fn(() => 'retained terminal tail')

    expect(readAgentPromptWaitText(cache, 7, readWaitText)).toBe('retained terminal tail')
    expect(readAgentPromptWaitText(cache, 7, readWaitText)).toBe('retained terminal tail')
    expect(readAgentPromptWaitText(cache, 8, readWaitText)).toBe('retained terminal tail')

    expect(readWaitText).toHaveBeenCalledTimes(2)
  })

  it('accepts an observed working transition', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    current = activity({ workingSequence: 5, status: 'working' })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toMatchObject({ evidence: 'activity' })
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

    await expect(verification).resolves.toMatchObject({ evidence: 'activity' })
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

  it('accepts a working transition after the former five-second deadline', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    await vi.advanceTimersByTimeAsync(5_000)
    current = activity({ workingSequence: 5, status: 'working' })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toMatchObject({ evidence: 'activity' })
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

  it('accepts a hook working status recorded after the baseline', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    // No workingSequence edge: the window-gated synthetic title never ran (hidden window/headless).
    current = activity({ explicitWorkingStartedAt: 2_000, status: 'working' })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toMatchObject({ evidence: 'activity' })
  })

  it('does not accept a hook working status that predates the baseline', async () => {
    vi.useFakeTimers()
    const current = activity({ explicitWorkingStartedAt: 2_000, status: 'working' })
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  // Why: same-state hook pings refresh the row without starting a turn, so only the pinned
  // stateStartedAt may satisfy the check — a refreshed row must stay unproven.
  it('does not accept a refreshed hook row whose working turn did not restart', async () => {
    vi.useFakeTimers()
    let current = activity({ explicitWorkingStartedAt: 2_000 })
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    current = activity({ explicitWorkingStartedAt: 2_000, outputSequence: 40 })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('accepts pane output after Enter when the agent was already working', async () => {
    vi.useFakeTimers()
    let current = activity({ status: 'working' })
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })

    current = activity({ status: 'working', outputSequence: 8 })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toMatchObject({ evidence: 'activity' })
  })

  it('does not accept pane output when the agent was idle at submit', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_stalled')

    current = activity({ outputSequence: 9 })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS)

    await rejected
  })

  it('holds the extended hook window open past the former hook timeout', async () => {
    vi.useFakeTimers()
    let current = activity()
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      timeoutMs: AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS
    })

    await vi.advanceTimersByTimeAsync(15_000 + 1_000)
    current = activity({ explicitWorkingStartedAt: 9_000, status: 'working' })
    await vi.advanceTimersByTimeAsync(50)

    await expect(verification).resolves.toMatchObject({ evidence: 'activity' })
  })

  it('gives hook-observed agents the longer effect window', () => {
    expect(resolveAgentPromptEffectTimeoutMs('codex')).toBe(AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS)
    expect(resolveAgentPromptEffectTimeoutMs('kimi')).toBe(AGENT_PROMPT_HOOK_EFFECT_TIMEOUT_MS)
    expect(resolveAgentPromptEffectTimeoutMs('claude')).toBe(AGENT_PROMPT_EFFECT_TIMEOUT_MS)
    expect(resolveAgentPromptEffectTimeoutMs(null)).toBe(AGENT_PROMPT_EFFECT_TIMEOUT_MS)
  })

  it('recognizes a stalled verdict from a message or a relayed error code', () => {
    expect(isAgentPromptStalledError(new Error('agent_prompt_stalled'))).toBe(true)
    expect(isAgentPromptStalledError({ code: 'agent_prompt_stalled' })).toBe(true)
    expect(isAgentPromptStalledError(new Error('terminal_not_writable'))).toBe(false)
    expect(isAgentPromptStalledError(null)).toBe(false)
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

describe('agent prompt submission verification with a composer observer', () => {
  afterEach(() => vi.useRealTimers())

  function composerObserver(
    verdicts: AgentPromptComposerVerdict[],
    beforeSubmit: AgentPromptComposerVerdict = 'pending'
  ) {
    // Why: the last verdict repeats, the way a screen keeps showing the same frame.
    const read = vi.fn(async () => (verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!))
    const resubmit = vi.fn()
    return { observer: { beforeSubmit, read, resubmit }, read, resubmit }
  }

  it('re-sends Enter with backoff while the composer keeps the payload, then accepts activity', async () => {
    vi.useFakeTimers()
    let current = activity()
    const { observer, resubmit } = composerObserver(['pending', 'pending', 'clear'])
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      composer: observer
    })

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS[0]! + 100)
    expect(resubmit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(
      AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS[1]! - AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS[0]!
    )
    expect(resubmit).toHaveBeenCalledTimes(2)

    current = activity({ workingSequence: 5, status: 'working' })
    // Why: the payload was last seen parked, so the activity only counts after a composer re-read.
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_COMPOSER_CLEAR_CONFIRM_MS + 100)

    await expect(verification).resolves.toEqual({ evidence: 'activity', enterRetries: 2 })
  })

  it('accepts a payload that was visible before Enter and stays cleared afterwards', async () => {
    vi.useFakeTimers()
    const current = activity()
    const { observer, read, resubmit } = composerObserver(['clear', 'clear'])
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      composer: observer
    })

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS[0]! + 100)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_COMPOSER_CLEAR_CONFIRM_MS + 100)

    await expect(verification).resolves.toEqual({ evidence: 'composer-cleared', enterRetries: 0 })
    expect(read).toHaveBeenCalledTimes(2)
    expect(resubmit).not.toHaveBeenCalled()
  })

  it('does not accept one cleared read that the confirmation read contradicts', async () => {
    vi.useFakeTimers()
    const current = activity()
    const { observer, resubmit } = composerObserver(['clear', 'pending', 'pending', 'pending'])
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      composer: observer,
      timeoutMs: 10_000
    })
    const rejected = expect(verification).rejects.toThrow(AGENT_PROMPT_STALLED_ERROR)

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS[1]! + 100)
    expect(resubmit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)

    await rejected
  })

  it('accepts a cleared composer after a retry made the payload visible first', async () => {
    vi.useFakeTimers()
    const current = activity()
    const { observer, resubmit } = composerObserver(['pending', 'clear', 'clear'], 'clear')
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      composer: observer
    })

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS[1]! + 100)
    expect(resubmit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_COMPOSER_CLEAR_CONFIRM_MS + 100)

    await expect(verification).resolves.toEqual({ evidence: 'composer-cleared', enterRetries: 1 })
  })

  it('never re-sends Enter while the composer reads clear or unknown', async () => {
    vi.useFakeTimers()
    for (const verdict of ['clear', 'unknown'] as const) {
      const current = activity()
      const { observer, resubmit } = composerObserver([verdict], verdict)
      const verification = verifyAgentPromptSubmission({
        baseline: current,
        readActivity: () => current,
        composer: observer
      })
      const rejected = expect(verification).rejects.toThrow(AGENT_PROMPT_STALLED_ERROR)

      await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS + 100)

      await rejected
      expect(resubmit).not.toHaveBeenCalled()
    }
  })

  it('extends the deadline once while the payload is still parked and reports the verdict', async () => {
    vi.useFakeTimers()
    const current = activity()
    const { observer, resubmit } = composerObserver(['pending'])
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      composer: observer
    })
    let settled: unknown = null
    verification.then(
      () => (settled = 'resolved'),
      (error: unknown) => (settled = error)
    )

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_EFFECT_TIMEOUT_MS + 100)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_PENDING_COMPOSER_GRACE_MS + 100)

    expect(settled).toBeInstanceOf(Error)
    expect(isAgentPromptStalledError(settled)).toBe(true)
    expect(settled).toMatchObject({
      composer: 'pending',
      enterRetries: AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS.length
    })
    expect(resubmit).toHaveBeenCalledTimes(AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS.length)
  })

  // Why: a busy agent keeps printing after Enter whether or not it took the paste; the parked
  // payload on screen outranks that activity until the composer is seen to let go of it.
  it('does not accept activity while the payload still reads pending, then accepts once it clears', async () => {
    vi.useFakeTimers()
    // Reads: 0ms, 500ms, 1000ms (activity-triggered, one per confirm window), 1500ms (checkpoint,
    // still pending → Enter again), 2000ms (cleared → the activity finally counts).
    const { observer, read, resubmit } = composerObserver([
      'pending',
      'pending',
      'pending',
      'pending',
      'clear'
    ])
    const baseline = activity({ status: 'working' })
    const verification = verifyAgentPromptSubmission({
      baseline,
      readActivity: () => activity({ status: 'working', outputSequence: 9 }),
      composer: observer
    })
    let settled = false
    verification.then(
      () => (settled = true),
      () => (settled = true)
    )

    await vi.advanceTimersByTimeAsync(100)
    expect(read).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS[0]!)
    expect(resubmit).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_COMPOSER_CLEAR_CONFIRM_MS + 100)

    await expect(verification).resolves.toEqual({ evidence: 'activity', enterRetries: 1 })
    expect(read).toHaveBeenCalledTimes(5)
  })

  it('rejects request_aborted when the signal fires during a deferred composer read', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let releaseRead!: (verdict: AgentPromptComposerVerdict) => void
    const read = vi.fn(
      () => new Promise<AgentPromptComposerVerdict>((resolve) => (releaseRead = resolve))
    )
    const baseline = activity({ status: 'working' })
    const verification = verifyAgentPromptSubmission({
      baseline,
      readActivity: () => activity({ status: 'working', outputSequence: 9 }),
      composer: { beforeSubmit: 'pending', read, resubmit: vi.fn() },
      signal: controller.signal
    })
    const rejected = expect(verification).rejects.toThrow('request_aborted')

    await vi.advanceTimersByTimeAsync(100)
    expect(read).toHaveBeenCalledTimes(1)
    controller.abort()
    releaseRead('clear')

    await rejected
  })

  it('does not re-send Enter once a permission state appears', async () => {
    vi.useFakeTimers()
    let current = activity()
    const { observer, resubmit } = composerObserver(['pending'])
    const verification = verifyAgentPromptSubmission({
      baseline: current,
      readActivity: () => current,
      composer: observer
    })
    const rejected = expect(verification).rejects.toThrow('agent_prompt_blocked')

    current = activity({ status: 'permission' })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_RETRY_DELAYS_MS[0]! + 100)

    await rejected
    expect(resubmit).not.toHaveBeenCalled()
  })
})
