import { afterEach, describe, expect, it, vi } from 'vitest'
import { startAgentExitRetirementOperation } from './agent-exit-retirement-operation'

afterEach(() => {
  vi.useRealTimers()
})

describe('startAgentExitRetirementOperation (R1D-1)', () => {
  it('retries a failed relay at 1 s and settles on the applied disposition', async () => {
    vi.useFakeTimers()
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('renderer_unavailable'))
      .mockResolvedValueOnce('applied')
    const onSettled = vi.fn()
    startAgentExitRetirementOperation({ attempt, stillOwed: () => true, onSettled })
    await vi.advanceTimersByTimeAsync(0)
    expect(onSettled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(onSettled).toHaveBeenCalledWith('applied', undefined)
  })

  it('gives up after three attempts and reports once', async () => {
    vi.useFakeTimers()
    const attempt = vi.fn().mockRejectedValue(new Error('chat_view_relay_timeout'))
    const onSettled = vi.fn()
    startAgentExitRetirementOperation({ attempt, stillOwed: () => true, onSettled })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]![0]).toBe('failed')
  })

  it('stops as soon as the run is no longer owed (a user switch, replacement, teardown)', async () => {
    vi.useFakeTimers()
    let owed = true
    const attempt = vi.fn().mockRejectedValue(new Error('renderer_unavailable'))
    const onSettled = vi.fn()
    startAgentExitRetirementOperation({ attempt, stillOwed: () => owed, onSettled })
    await vi.advanceTimersByTimeAsync(0)
    owed = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledWith('abandoned', undefined)
  })

  it('a superseded or missing answer is final, not counted as applied', async () => {
    const onSettled = vi.fn()
    startAgentExitRetirementOperation({
      attempt: async () => 'superseded',
      stillOwed: () => true,
      onSettled
    })
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith('superseded', undefined))
  })

  it('a renderer-ready nudge spends the next attempt early', async () => {
    vi.useFakeTimers()
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('renderer_unavailable'))
      .mockResolvedValueOnce('applied')
    const onSettled = vi.fn()
    const operation = startAgentExitRetirementOperation({
      attempt,
      stillOwed: () => true,
      onSettled
    })
    await vi.advanceTimersByTimeAsync(0)
    operation.nudge()
    await vi.advanceTimersByTimeAsync(0)
    expect(onSettled).toHaveBeenCalledWith('applied', undefined)
  })
})
