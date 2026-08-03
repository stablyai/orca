import { describe, expect, it, vi } from 'vitest'
import { JiraCancellableRequests } from './jira-cancellable-requests'

describe('JiraCancellableRequests', () => {
  it('aborts a late run when cancel arrived before registration', async () => {
    const requests = new JiraCancellableRequests()
    requests.cancel('req-1')

    const signals: AbortSignal[] = []
    await expect(
      requests.run('req-1', async (signal) => {
        signals.push(signal)
        if (signal.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        }
        return 'ok'
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('aborts an in-flight run on cancel', async () => {
    const requests = new JiraCancellableRequests()
    const resolveBox: { current?: (value: string) => void } = {}
    const started = new Promise<AbortSignal>((resolve) => {
      void requests.run('req-2', (signal) => {
        resolve(signal)
        return new Promise<string>((taskResolve) => {
          resolveBox.current = taskResolve
          signal.addEventListener(
            'abort',
            () => {
              taskResolve('aborted')
            },
            { once: true }
          )
        })
      })
    })

    const signal = await started
    expect(signal.aborted).toBe(false)
    requests.cancel('req-2')
    expect(signal.aborted).toBe(true)
    resolveBox.current?.('done')
  })

  it('ignores blank request ids', async () => {
    const requests = new JiraCancellableRequests()
    const task = vi.fn(async () => 'ok')
    await expect(requests.run('   ', task)).resolves.toBe('ok')
    requests.cancel('   ')
    expect(task).toHaveBeenCalledTimes(1)
  })
})
