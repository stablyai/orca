import { describe, expect, it } from 'vitest'
import type { RuntimeBrowserCommandHost } from '../../runtime/browser/commands/browser-command-contracts'
import { RuntimeBrowserPageRegistry } from '../../runtime/browser/client-pages/runtime-browser-page-registry'
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
})
