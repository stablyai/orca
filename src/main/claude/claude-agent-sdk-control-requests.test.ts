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

describe('createClaudeControlSurface generateSessionTitle', () => {
  it('asks the CLI to persist the title it returns', async () => {
    const generateSessionTitle = vi
      .fn<(description: string, options?: { persist?: boolean }) => Promise<string>>()
      .mockResolvedValue('  Lease probe repair  ')
    const controls = createClaudeControlSurface({ generateSessionTitle } as unknown as Query)

    await expect(
      controls.generateSessionTitle('fix the probe', { persist: true })
    ).resolves.toEqual({ outcome: 'named', title: 'Lease probe repair' })
    expect(generateSessionTitle).toHaveBeenCalledWith('fix the probe', { persist: true })
  })

  it('declines on an unusable reply and reports an absent request as unsupported', async () => {
    const generateSessionTitle = vi.fn<() => Promise<string | null>>().mockResolvedValue('   ')

    await expect(
      createClaudeControlSurface({ generateSessionTitle } as unknown as Query).generateSessionTitle(
        'fix the probe',
        { persist: true }
      )
    ).resolves.toEqual({ outcome: 'declined' })
    await expect(
      createClaudeControlSurface({} as unknown as Query).generateSessionTitle('fix the probe')
    ).resolves.toEqual({ outcome: 'unsupported' })
  })
})
