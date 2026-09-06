import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClaudeControlSurface } from './claude-agent-sdk-control-requests'

afterEach(() => {
  vi.useRealTimers()
})

describe('createClaudeControlSurface stopTask', () => {
  it('bounds a lost reply and permits a later stop request', async () => {
    vi.useFakeTimers()
    const stopTask = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce()
    const controls = createClaudeControlSurface({ stopTask } as unknown as Query)
    const timedOut = expect(controls.stopTask('task-1', { timeoutMs: 25 })).rejects.toThrow(
      'claude stop_task request timed out'
    )

    await vi.advanceTimersByTimeAsync(25)
    await timedOut
    await expect(controls.stopTask('task-2', { timeoutMs: 25 })).resolves.toBeUndefined()
    expect(stopTask).toHaveBeenCalledTimes(2)
  })
})
