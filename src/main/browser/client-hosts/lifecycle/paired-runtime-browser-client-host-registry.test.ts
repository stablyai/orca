import { describe, expect, it } from 'vitest'
import type { BrowserClientHostLeaseAuthority } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { PairedRuntimeBrowserClientHostRegistry } from './paired-runtime-browser-client-host-registry'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-b',
  authorityEpoch: 'epoch-b',
  browserHostClientId: 'client-a',
  browserHostGeneration: 1,
  pageCommandProtocolVersion: 1
}

describe('PairedRuntimeBrowserClientHostRegistry', () => {
  it('accepts a new host once a failed authority replacement finishes failing its cleanup', async () => {
    let failCleanup = (_error: Error): void => {}
    const cleanup = new Promise<void>((_resolve, reject) => {
      failCleanup = reject
    })
    const started: string[] = []
    const registry = new PairedRuntimeBrowserClientHostRegistry({
      createComposition: (input) => {
        started.push(input.authorityRuntimeId)
        const first = started.length === 1
        return {
          start: async () => authority,
          replaceAuthority: async () => {
            throw new Error('replacement attach failed')
          },
          retirePage: async () => true,
          hostsPage: () => false,
          close: async () => !first,
          whenClosed: () => (first ? cleanup : Promise.resolve())
        }
      }
    })
    const start = (authorityRuntimeId: string) =>
      registry.start({ environmentId: 'environment-a', pairingRevision: 1, authorityRuntimeId })

    await start('runtime-a')
    await expect(start('runtime-b')).rejects.toThrow('replacement attach failed')
    await expect(start('runtime-b')).rejects.toThrow(
      'paired_runtime_browser_client_host_cleanup_pending'
    )

    failCleanup(new Error('browser_client_page_renderer_request_timeout'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(start('runtime-b')).resolves.toEqual(authority)
    expect(started).toEqual(['runtime-a', 'runtime-b'])
  })
})
