import { afterEach, describe, expect, it, vi } from 'vitest'
import { groupSetupAgentOutcome } from './group-setup-agent-outcome'

afterEach(() => vi.useRealTimers())

describe('required group setup observation', () => {
  it('expires the observer without releasing an agent when late success arrives', async () => {
    vi.useFakeTimers()
    let complete: ((value: { exitCode: number | null }) => void) | undefined
    let observation: AbortSignal | undefined
    const result = groupSetupAgentOutcome({
      required: true,
      prepared: true,
      terminalHandle: 'setup',
      wait: (_, signal) => {
        observation = signal
        return new Promise((resolve) => {
          complete = resolve
        })
      }
    })
    await vi.advanceTimersByTimeAsync(59_999)
    let settled = false
    void result.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ status: 'failed', reason: 'timeout' })
    expect(observation?.aborted).toBe(true)
    complete?.({ exitCode: 0 })
    await Promise.resolve()
    expect(await result).toEqual({ status: 'failed', reason: 'timeout' })
  })
})
