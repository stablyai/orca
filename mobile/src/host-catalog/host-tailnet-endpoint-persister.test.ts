import { describe, expect, it, vi } from 'vitest'
import { createTailnetEndpointPersister } from './host-tailnet-endpoint-persister'

const A = 'ws://100.64.0.1:6768/'
const B = 'ws://100.64.0.2:6768/'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

describe('tailnet endpoint persister', () => {
  it('retries the same endpoint after a failed write, then stops once it lands', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined)
    const record = createTailnetEndpointPersister(undefined, write)
    record(A)
    await settle()
    record(A)
    await settle()
    record(A)
    await settle()
    expect(write.mock.calls).toEqual([[A], [A]])
  })

  it('never overlaps writes and ends on the latest endpoint', async () => {
    const releases: (() => void)[] = []
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        })
    )
    const record = createTailnetEndpointPersister(undefined, write)
    record(A)
    record(B)
    await settle()
    expect(write.mock.calls).toEqual([[A]])

    releases[0]!()
    await settle()
    expect(write.mock.calls).toEqual([[A], [B]])
    releases[1]!()
    await settle()
    record(B)
    await settle()
    expect(write).toHaveBeenCalledTimes(2)
  })
})
