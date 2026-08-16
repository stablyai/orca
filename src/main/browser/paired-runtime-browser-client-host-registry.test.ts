import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import { PairedRuntimeBrowserClientHostRegistry } from './paired-runtime-browser-client-host-registry'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 2,
  pageCommandProtocolVersion: 1
}

describe('PairedRuntimeBrowserClientHostRegistry', () => {
  it('shares one composition for the exact environment pairing revision', async () => {
    const composition = createComposition()
    const compositionFactory = vi.fn(() => composition)
    const registry = new PairedRuntimeBrowserClientHostRegistry({
      createComposition: compositionFactory
    })

    const first = registry.start(input(11))
    const second = registry.start(input(11))

    await expect(Promise.all([first, second])).resolves.toEqual([authority, authority])
    expect(compositionFactory).toHaveBeenCalledOnce()
    expect(composition.start).toHaveBeenCalledOnce()
  })

  it('closes an old pairing revision before creating its replacement', async () => {
    const order: string[] = []
    const first = createComposition(order, 'start-first', 'close-first')
    const second = createComposition(order, 'start-second', 'close-second')
    const registry = new PairedRuntimeBrowserClientHostRegistry({
      createComposition: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    })
    await registry.start(input(11))

    await registry.start(input(12))

    expect(order).toEqual(['start-first', 'close-first', 'start-second'])
  })

  it('preserves the composition across a runtime authority transition', async () => {
    const composition = createComposition()
    const compositionFactory = vi.fn(() => composition)
    const registry = new PairedRuntimeBrowserClientHostRegistry({
      createComposition: compositionFactory
    })
    await registry.start(input(11))

    await registry.start(input(11, 'runtime-b'))

    expect(compositionFactory).toHaveBeenCalledOnce()
    expect(composition.replaceAuthority).toHaveBeenCalledWith(input(11, 'runtime-b'))
    expect(composition.close).not.toHaveBeenCalled()
  })

  it('keeps a failed authority transition tombstoned until cleanup settles', async () => {
    const cleanup = deferred<void>()
    const failed = createComposition(undefined, undefined, undefined, false, cleanup.promise)
    failed.replaceAuthority.mockRejectedValueOnce(new Error('replacement attach failed'))
    const replacement = createComposition()
    const compositionFactory = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(replacement)
    const registry = new PairedRuntimeBrowserClientHostRegistry({
      createComposition: compositionFactory
    })
    await registry.start(input(11))

    await expect(registry.start(input(11, 'runtime-b'))).rejects.toThrow(
      'replacement attach failed'
    )
    await expect(registry.start(input(11, 'runtime-b'))).rejects.toThrow(
      'paired_runtime_browser_client_host_cleanup_pending'
    )
    expect(replacement.start).not.toHaveBeenCalled()

    cleanup.resolve()
    await cleanup.promise
    await expect(registry.start(input(11, 'runtime-b'))).resolves.toEqual(authority)
    expect(replacement.start).toHaveBeenCalledOnce()
  })

  it('blocks replacement when the old host cannot prove handler settlement', async () => {
    const cleanup = deferred<void>()
    const first = createComposition(undefined, undefined, undefined, false, cleanup.promise)
    const second = createComposition()
    const compositionFactory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const registry = new PairedRuntimeBrowserClientHostRegistry({
      createComposition: compositionFactory
    })
    await registry.start(input(11))

    await expect(registry.start(input(12))).rejects.toThrow(
      'paired_runtime_browser_client_host_cleanup_pending'
    )

    expect(compositionFactory).toHaveBeenCalledOnce()
    expect(second.start).not.toHaveBeenCalled()

    cleanup.resolve()
    await cleanup.promise
    await expect(registry.start(input(12))).resolves.toEqual(authority)
    expect(second.start).toHaveBeenCalledOnce()
  })

  it('keeps replacement fenced when deferred cleanup cannot prove completion', async () => {
    const cleanup = deferred<void>()
    const first = createComposition(undefined, undefined, undefined, false, cleanup.promise)
    const second = createComposition()
    const compositionFactory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const registry = new PairedRuntimeBrowserClientHostRegistry({
      createComposition: compositionFactory
    })
    await registry.start(input(11))

    await expect(registry.start(input(12))).rejects.toThrow(
      'paired_runtime_browser_client_host_cleanup_pending'
    )
    cleanup.reject(new Error('cleanup unresolved'))
    await cleanup.promise.catch(() => undefined)
    await expect(registry.start(input(12))).rejects.toThrow(
      'paired_runtime_browser_client_host_cleanup_pending'
    )

    expect(compositionFactory).toHaveBeenCalledOnce()
    expect(second.start).not.toHaveBeenCalled()
  })

  it('closes only the selected environment and permits a later exact restart', async () => {
    const first = createComposition()
    const second = createComposition()
    const compositionFactory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const registry = new PairedRuntimeBrowserClientHostRegistry({
      createComposition: compositionFactory
    })
    await registry.start(input(11))

    await expect(registry.closeEnvironment('environment-a')).resolves.toBe(true)
    await registry.start(input(11))

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.start).toHaveBeenCalledOnce()
  })

  it('permanently fences new starts before closing every environment', async () => {
    const first = createComposition()
    const second = createComposition()
    const registry = new PairedRuntimeBrowserClientHostRegistry({
      createComposition: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    })
    await registry.start(input(11))
    await registry.start({ ...input(11), environmentId: 'environment-b' })

    await registry.close()

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
    await expect(registry.start(input(11))).rejects.toThrow(
      'paired_runtime_browser_client_host_registry_closed'
    )
  })
})

function createComposition(
  order?: string[],
  startLabel?: string,
  closeLabel?: string,
  closeSettled = true,
  closed = Promise.resolve()
) {
  return {
    start: vi.fn(async () => {
      if (order && startLabel) {
        order.push(startLabel)
      }
      return authority
    }),
    replaceAuthority: vi.fn(async () => ({ ...authority, authorityRuntimeId: 'runtime-b' })),
    retirePage: vi.fn(async () => true),
    close: vi.fn(async () => {
      if (order && closeLabel) {
        order.push(closeLabel)
      }
      return closeSettled
    }),
    whenClosed: vi.fn(() => closed)
  }
}

function deferred<T>() {
  let resolve = (_value: T): void => {}
  let reject = (_error: unknown): void => {}
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, reject, resolve }
}

function input(pairingRevision: number, authorityRuntimeId = 'runtime-a') {
  return {
    environmentId: 'environment-a',
    pairingRevision,
    authorityRuntimeId
  }
}
