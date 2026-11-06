import { describe, expect, it } from 'vitest'
import { CallerJoinedSharedTasks } from './caller-joined-shared-task'

describe('CallerJoinedSharedTasks', () => {
  it('resolves joined callers when the shared task fails', async () => {
    const tasks = new CallerJoinedSharedTasks<string>()
    let starts = 0
    const start = async (): Promise<void> => {
      starts += 1
      throw new Error('refresh failed')
    }

    await expect(
      Promise.all([
        tasks.join('claude', new AbortController().signal, start),
        tasks.join('claude', new AbortController().signal, start)
      ])
    ).resolves.toEqual([undefined, undefined])
    expect(starts).toBe(1)
  })

  it('starts a fresh task for a caller joining after every earlier caller aborted', async () => {
    const tasks = new CallerJoinedSharedTasks<string>()
    const signals: AbortSignal[] = []
    const start = (signal: AbortSignal): Promise<void> => {
      signals.push(signal)
      return new Promise(() => {})
    }
    const first = new AbortController()

    const abandoned = tasks.join('codex', first.signal, start)
    first.abort()
    await abandoned
    void tasks.join('codex', new AbortController().signal, start)

    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
  })
})
