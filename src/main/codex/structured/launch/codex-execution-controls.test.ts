import { expect, it, vi } from 'vitest'
import { createCodexExecutionControls } from './codex-execution-controls'

const policy = {
  schema: 1 as const,
  sourcePin: 'a'.repeat(40),
  accountFingerprint: `codex:${'b'.repeat(64)}`,
  model: 'gpt-live',
  effort: 'low',
  deadlineAt: 1_800_000_120_000,
  access: 'read-only' as const
}

it('closes its exact owned child at the monotonic ceiling even if the wall clock moves back', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  const close = vi.fn(async () => false)
  try {
    const fault = vi.fn()
    const control = createCodexExecutionControls(policy, close, fault)
    vi.setSystemTime(1_700_000_000_000)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(close).toHaveBeenCalled()
    expect(() => control.assertOpen()).toThrow('Bounded Codex deadline reached.')
    expect(fault).toHaveBeenCalledWith(new Error('Bounded Codex process exit unproven.'))
    control.end()
  } finally {
    vi.useRealTimers()
  }
})

it('never treats a stop request or rejected close as exit proof', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  try {
    const fault = vi.fn()
    const control = createCodexExecutionControls(
      policy,
      async () => {
        throw new Error('unknown')
      },
      fault
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fault).toHaveBeenCalledWith(new Error('Bounded Codex process exit unproven.'))
    control.end()
  } finally {
    vi.useRealTimers()
  }
})
