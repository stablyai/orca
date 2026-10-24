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
