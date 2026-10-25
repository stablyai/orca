import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceSetupAgentStartHolds } from './workspace-setup-agent-start-holds'

afterEach(() => {
  vi.useRealTimers()
})

it('lets the agent start anyway when setup outlives the wait', async () => {
  vi.useFakeTimers()
  const holds = new WorkspaceSetupAgentStartHolds()
  let observed: AbortSignal | undefined
  holds.hold('wt-1')((signal) => {
    observed = signal
    return new Promise(() => {})
  })
  const pending = holds.pending('wt-1')
  expect(pending).not.toBeNull()

  await vi.advanceTimersByTimeAsync(59_000)
  expect(holds.pending('wt-1')).toBe(pending)
  await vi.advanceTimersByTimeAsync(1_000)

  await expect(pending).resolves.toBeUndefined()
  expect(observed?.aborted).toBe(true)
  expect(holds.pending('wt-1')).toBeNull()
})

it('a reported gap leaves chat held until its existing deadline, without a fabricated failure', async () => {
  const { createSetupCompletionObservation } =
    await import('./orchestration/setup-completion-signal')
  vi.useFakeTimers()
  const holds = new WorkspaceSetupAgentStartHolds()
  const observed = createSetupCompletionObservation('native:gap', true)
  holds.hold('gap')(() => observed.completion)
  const held = holds.pending('gap')
  observed.noteGap()
  const receipt = 'ORCA_SETUP_DONE:native:gap:0;'
  observed.scan(receipt, receipt.length, false, receipt.length)
  observed.publish()
  await vi.advanceTimersByTimeAsync(59_999)
  expect(observed.unknown).toBe(true)
  expect(holds.pending('gap')).toBe(held)
  await vi.advanceTimersByTimeAsync(1)
  await expect(held).resolves.toBeUndefined()
  expect(holds.pending('gap')).toBeNull()
})
