import { describe, expect, it } from 'vitest'

import { JiraCancellableRequests } from './cancellable-requests'

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
})
