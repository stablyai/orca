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

/** A query exposing only the cancel method, as the surface reads nothing else for it. */
function queryWithCancel(cancelAsyncMessage?: (uuid: string) => Promise<unknown>): Query {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cancelAsyncMessage reads only this member.
  return (cancelAsyncMessage ? { cancelAsyncMessage } : {}) as unknown as Query
}

describe('createClaudeControlSurface cancelAsyncMessage', () => {
  it('reports a withdrawal only when the CLI answers cancelled: true', async () => {
    // An older CLI answers with an empty success, which carries no `cancelled`.
    const cancelAsyncMessage = vi
      .fn<(uuid: string) => Promise<unknown>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined)
    const controls = createClaudeControlSurface(queryWithCancel(cancelAsyncMessage))

    await expect(controls.cancelAsyncMessage('queued-1')).resolves.toBe(true)
    await expect(controls.cancelAsyncMessage('queued-2')).resolves.toBe(false)
    await expect(controls.cancelAsyncMessage('queued-3')).resolves.toBe(false)
    expect(cancelAsyncMessage.mock.calls).toEqual([['queued-1'], ['queued-2'], ['queued-3']])
    await expect(
      createClaudeControlSurface(queryWithCancel()).cancelAsyncMessage('queued-4')
    ).resolves.toBe(false)
  })
})
