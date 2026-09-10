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
  it('reports UNSUPPORTED when the CLI exposes no title request at all', async () => {
    // The real degradation path: the shipped Query declaration omits the method,
    // and an older CLI genuinely does not have it. Distinguished from a decline
    // so a caller never records "we already asked" against a CLI that could not
    // be asked — which would forfeit naming even after the user upgrades.
    const surface = createClaudeControlSurface({} as unknown as Query)

    await expect(surface.generateSessionTitle('fix the lease probe')).resolves.toEqual({
      outcome: 'unsupported'
    })
  })

  it('asks the CLI to persist the title and trims what comes back', async () => {
    const generateSessionTitle = vi.fn(async () => '  Lease probe flake  ')
    const surface = createClaudeControlSurface({ generateSessionTitle } as unknown as Query)

    await expect(
      surface.generateSessionTitle('fix the lease probe', { persist: true })
    ).resolves.toEqual({ outcome: 'named', title: 'Lease probe flake' })
    expect(generateSessionTitle).toHaveBeenCalledWith('fix the lease probe', { persist: true })
  })

  it('treats a blank title as a decline, which a CLI that CAN be asked produced', async () => {
    const surface = createClaudeControlSurface({
      generateSessionTitle: async () => '   '
    } as unknown as Query)

    await expect(surface.generateSessionTitle('fix the lease probe')).resolves.toEqual({
      outcome: 'declined'
    })
  })
})
