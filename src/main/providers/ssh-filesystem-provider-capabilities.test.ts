import { describe, expect, it, vi } from 'vitest'
import {
  probeSshQuickOpenSearchCapability,
  probeSshRangedReadCapability
} from './ssh-filesystem-provider-capabilities'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'

describe('SSH Quick Open capability probe', () => {
  it('recognizes the query-aware relay', async () => {
    const mux = { request: vi.fn().mockResolvedValue({ quickOpenSearchVersion: 1 }) }
    await expect(probeSshQuickOpenSearchCapability(mux as never)).resolves.toBe(true)
    await expect(probeSshQuickOpenSearchCapability(mux as never)).resolves.toBe(true)
    expect(mux.request).toHaveBeenCalledTimes(1)
    expect(mux.request).toHaveBeenCalledWith('fs.getCapabilities', undefined, {
      signal: undefined,
      timeoutMs: 5_000
    })
  })

  it('lets callers treat a missing capability as legacy', async () => {
    const mux = {
      request: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('method not found'), { code: JsonRpcErrorCode.MethodNotFound })
        )
    }
    await expect(probeSshQuickOpenSearchCapability(mux as never)).resolves.toBe(false)
    await expect(probeSshQuickOpenSearchCapability(mux as never)).resolves.toBe(false)
    expect(mux.request).toHaveBeenCalledTimes(1)
  })

  it('does not downgrade transport failures to legacy behavior', async () => {
    const mux = { request: vi.fn().mockRejectedValue(new Error('connection closed')) }
    await expect(probeSshQuickOpenSearchCapability(mux as never)).rejects.toThrow(
      'connection closed'
    )
  })
})

describe('SSH filesystem capability document', () => {
  // fs.getCapabilities answers every feature at once. Probing per feature would
  // spend an extra round trip per connection for a document already in hand.
  it('is fetched once for every feature probe on a connection', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue({ quickOpenSearchVersion: 1, rangedReadVersion: 1 })
    }
    await expect(probeSshQuickOpenSearchCapability(mux as never)).resolves.toBe(true)
    await expect(probeSshRangedReadCapability(mux as never)).resolves.toBe(true)
    expect(mux.request).toHaveBeenCalledTimes(1)
  })

  it('reads each feature independently off the shared document', async () => {
    const mux = { request: vi.fn().mockResolvedValue({ quickOpenSearchVersion: 1 }) }
    await expect(probeSshQuickOpenSearchCapability(mux as never)).resolves.toBe(true)
    await expect(probeSshRangedReadCapability(mux as never)).resolves.toBe(false)
  })

  // A transport failure is not a verdict about the host, so it must not be the
  // cached answer for the rest of the connection's life.
  it('retries after a failed fetch instead of caching the failure', async () => {
    const mux = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error('connection closed'))
        .mockResolvedValue({ rangedReadVersion: 1 })
    }
    await expect(probeSshRangedReadCapability(mux as never)).rejects.toThrow('connection closed')
    await expect(probeSshRangedReadCapability(mux as never)).resolves.toBe(true)
    expect(mux.request).toHaveBeenCalledTimes(2)
  })

  // One document now backs every feature, so a caller walking away from its own
  // probe must not evict the fetch a second feature is still waiting on --
  // otherwise an aborted quick-open probe costs the ranged-read probe a round
  // trip, and a caller that keeps aborting re-fetches forever.
  it('keeps the in-flight document when one caller aborts its own probe', async () => {
    let settle: (value: Record<string, unknown>) => void = () => {}
    const mux = {
      request: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Record<string, unknown>>((resolve) => {
              settle = resolve
            })
        )
        .mockResolvedValue({ rangedReadVersion: 1 })
    }
    const controller = new AbortController()
    const abandoned = probeSshQuickOpenSearchCapability(mux as never, controller.signal)
    const patient = probeSshRangedReadCapability(mux as never)
    controller.abort()
    await expect(abandoned).rejects.toThrow('client_disconnected')

    settle({ rangedReadVersion: 1 })
    await expect(patient).resolves.toBe(true)
    await expect(probeSshRangedReadCapability(mux as never)).resolves.toBe(true)
    expect(mux.request).toHaveBeenCalledTimes(1)
  })

  it('retries when the fetch fails after its only waiter aborts', async () => {
    let rejectFetch: (error: Error) => void = () => {}
    const mux = {
      request: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectFetch = reject
            })
        )
        .mockResolvedValue({ rangedReadVersion: 1 })
    }
    const controller = new AbortController()
    const abandoned = probeSshRangedReadCapability(mux as never, controller.signal)
    controller.abort()
    await expect(abandoned).rejects.toThrow('client_disconnected')

    rejectFetch(new Error('connection closed'))
    await new Promise((resolve) => setImmediate(resolve))

    await expect(probeSshRangedReadCapability(mux as never)).resolves.toBe(true)
    expect(mux.request).toHaveBeenCalledTimes(2)
  })

  it('treats a non-object response as no capabilities', async () => {
    const mux = { request: vi.fn().mockResolvedValue('yes') }
    await expect(probeSshRangedReadCapability(mux as never)).resolves.toBe(false)
    await expect(probeSshQuickOpenSearchCapability(mux as never)).resolves.toBe(false)
  })
})
