import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserCommandHost } from '../../runtime/browser/commands/browser-command-contracts'
import { RuntimeBrowserPageRegistry } from '../../runtime/browser/client-pages/runtime-browser-page-registry'
import { BrowserHostLeaseRegistry } from '../../runtime/browser-host/leases/browser-host-lease-registry'
import { BrowserHostRequestRegistry } from '../../runtime/browser-host/leases/browser-host-request-registry'
import { orcadClientPageCommand } from './orcad-client-page-commands'

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`unexpected ${name}`)
  }
}

describe('orcad client page commands', () => {
  it('reports the profile of a page a paired desktop hosts without asking the engine', async () => {
    const pages = new RuntimeBrowserPageRegistry()
    pages.publishClientPage({
      browserPageId: 'desktop-page',
      workspaceId: 'wt-1',
      browserProfileId: 'default',
      executionHostKey: 'native:orcad',
      placement: {
        kind: 'client',
        browserHostClientId: 'desktop-1',
        browserHostGeneration: 1,
        pageHostGeneration: 1
      },
      url: 'https://user.example/',
      loading: false,
      active: true
    })
    const host: RuntimeBrowserCommandHost = {
      getRuntimeId: () => 'orcad',
      resolveWorkspaceSelector: async (selector) => ({ id: selector.replace(/^id:/, '') }),
      resolveBrowserWorkspace: async (selector) => ({ id: selector.replace(/^id:/, '') }),
      resolveBrowserNetworkExecutionHost: unexpected('execution host'),
      getAgentBrowserBridge: () => null,
      getRuntimeBrowserPageRegistry: () => pages,
      getBrowserHostLeaseRegistry: unexpected('lease registry'),
      getBrowserHostRequestRegistry: unexpected('request registry'),
      getAvailableAuthoritativeWindow: () => null,
      getOffscreenBrowserBackend: () => null,
      getAuthoritativeWindow: unexpected('window')
    }
    const show = orcadClientPageCommand(
      host,
      'browserTabProfileShow',
      unexpected('engine'),
      () => false
    )

    await expect(show?.({ page: 'desktop-page' })).resolves.toEqual({
      browserPageId: 'desktop-page',
      worktreeId: 'wt-1',
      profileId: 'default',
      profileLabel: 'Default'
    })
  })

  it("opens an agent's tab in the engine nobody sees only when it asks with --headless", async () => {
    const leases = new BrowserHostLeaseRegistry({
      authorityRuntimeId: 'orcad',
      authorityEpoch: 'e'
    })
    const volunteers = new BrowserHostRequestRegistry()
    const host: RuntimeBrowserCommandHost = {
      getRuntimeId: () => 'orcad',
      resolveWorkspaceSelector: async (selector) => ({ id: selector.replace(/^id:/, '') }),
      resolveBrowserWorkspace: async (selector) => ({ id: selector.replace(/^id:/, '') }),
      resolveBrowserNetworkExecutionHost: unexpected('execution host'),
      getAgentBrowserBridge: () => null,
      getRuntimeBrowserPageRegistry: () => new RuntimeBrowserPageRegistry(),
      getBrowserHostLeaseRegistry: () => leases,
      getBrowserHostRequestRegistry: () => volunteers,
      getAvailableAuthoritativeWindow: () => null,
      getOffscreenBrowserBackend: () => null,
      getAuthoritativeWindow: unexpected('window')
    }
    const engine = vi.fn(async () => ({ browserPageId: 'engine-page' }))
    const create = orcadClientPageCommand(host, 'browserTabCreate', engine, () => true)!

    await expect(create({ worktree: 'id:wt-1', url: 'https://example.com' })).rejects.toMatchObject(
      { code: 'browser_host_unavailable' }
    )
    await expect(create({ worktree: 'id:wt-1', url: 'file:///tmp/a.html' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(engine).not.toHaveBeenCalled()

    await expect(
      create({ worktree: 'id:wt-1', url: 'https://example.com', placement: { kind: 'server' } })
    ).resolves.toEqual({ browserPageId: 'engine-page' })
  })
})
