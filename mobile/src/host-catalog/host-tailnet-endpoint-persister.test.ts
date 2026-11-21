import { describe, expect, it, vi } from 'vitest'
import { createTailnetEndpointPersister } from './host-tailnet-endpoint-persister'

const A = 'ws://100.64.0.1:6768/'
const B = 'ws://100.64.0.2:6768/'

describe('tailnet endpoint persister', () => {
  it('retries the same endpoint after a failed write', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined)
    const record = createTailnetEndpointPersister(undefined, write)
    record(A)
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    record(A)
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    record(A)
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('writes A, B, A in order and ends on the latest endpoint', async () => {
    const written: string[] = []
    let release: () => void = () => undefined
    const write = vi.fn(async (endpoint: string) => {
      if (endpoint === B) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      written.push(endpoint)
    })
    const record = createTailnetEndpointPersister(A, write)
    record(B)
    record(A)
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(B))
    release()
    await vi.waitFor(() => expect(written).toEqual([B, A]))
  })
})
