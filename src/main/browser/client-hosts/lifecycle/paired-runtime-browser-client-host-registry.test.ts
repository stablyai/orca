import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostLeaseAuthority } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { PairedRuntimeBrowserClientHostRegistry } from './paired-runtime-browser-client-host-registry'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 2,
  pageCommandProtocolVersion: 1
}

describe('PairedRuntimeBrowserClientHostRegistry', () => {
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
    hostsPage: vi.fn((_browserPageId: string) => false),
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
