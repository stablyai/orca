import { describe, expect, it, vi } from 'vitest'
import { createPluginActivationCoalescer } from './plugin-activation-coalescer'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createPluginActivationCoalescer', () => {
  it('runs one activation for two concurrent callers of the same key', async () => {
    const gate = deferred()
    const start = vi.fn(() => gate.promise)
    const coalescer = createPluginActivationCoalescer(start)

    const both = Promise.all([coalescer.activate('acme.boards'), coalescer.activate('acme.boards')])
    gate.resolve()
    await both

    expect(start).toHaveBeenCalledOnce()
  })

  it('runs one activation for ten concurrent callers', async () => {
    const gate = deferred()
    const start = vi.fn(() => gate.promise)
    const coalescer = createPluginActivationCoalescer(start)

    const all = Promise.all(Array.from({ length: 10 }, () => coalescer.activate('acme.boards')))
    gate.resolve()
    await all

    expect(start).toHaveBeenCalledOnce()
  })

  it('joins a caller that arrives after the attempt started but before it settled', async () => {
    const gate = deferred()
    const start = vi.fn(() => gate.promise)
    const coalescer = createPluginActivationCoalescer(start)

    const first = coalescer.activate('acme.boards')
    await Promise.resolve()
    const late = coalescer.activate('acme.boards')
    gate.resolve()
    await Promise.all([first, late])

    expect(start).toHaveBeenCalledOnce()
  })

  it('rejects every joined caller with the shared failure', async () => {
    const gate = deferred()
    const start = vi.fn(() => gate.promise)
    const coalescer = createPluginActivationCoalescer(start)

    const first = coalescer.activate('acme.boards')
    const second = coalescer.activate('acme.boards')
    gate.reject(new Error('worker refused to start'))

    await expect(first).rejects.toThrow('worker refused to start')
    await expect(second).rejects.toThrow('worker refused to start')
    expect(start).toHaveBeenCalledOnce()
  })

  it('starts a fresh attempt once the shared one has settled', async () => {
    const start = vi.fn(async () => undefined)
    const coalescer = createPluginActivationCoalescer(start)

    await coalescer.activate('acme.boards')
    await coalescer.activate('acme.boards')

    expect(start).toHaveBeenCalledTimes(2)
  })

  it('retries after a failed attempt instead of caching the failure', async () => {
    const start = vi
      .fn<(pluginKey: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('not approved yet'))
      .mockResolvedValueOnce(undefined)
    const coalescer = createPluginActivationCoalescer(start)

    await expect(coalescer.activate('acme.boards')).rejects.toThrow('not approved yet')
    await expect(coalescer.activate('acme.boards')).resolves.toBeUndefined()
  })

  it('keeps activations of different plugin keys apart', async () => {
    const gate = deferred()
    const start = vi.fn<(pluginKey: string) => Promise<void>>(() => gate.promise)
    const coalescer = createPluginActivationCoalescer(start)

    const both = Promise.all([
      coalescer.activate('acme.boards'),
      coalescer.activate('acme.tickets')
    ])
    gate.resolve()
    await both

    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls.map(([key]) => key)).toEqual(['acme.boards', 'acme.tickets'])
  })
})
