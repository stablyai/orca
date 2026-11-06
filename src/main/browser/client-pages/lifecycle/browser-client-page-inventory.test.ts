import { describe, expect, it } from 'vitest'
import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { prepareBrowserClientPageInventoryForAttach } from './browser-client-page-inventory'

describe('browser client page inventory', () => {
  it('keeps URLs and duplicate-page validation when the inventory fits', () => {
    const page = { ...inventoryPage('page-a'), currentUrl: 'https://example.test/' }
    expect(prepareBrowserClientPageInventoryForAttach([page])).toEqual([page])
    expect(prepareBrowserClientPageInventoryForAttach([page, page])).toBeUndefined()
  })

  it('declines the optional snapshot instead of dropping an unencodable page', () => {
    expect(
      prepareBrowserClientPageInventoryForAttach([
        inventoryPage('page-a'),
        { ...inventoryPage('page-b'), browserProfileId: '\0'.repeat(256) }
      ])
    ).toBeUndefined()
  })
})

function inventoryPage(browserPageId: string): BrowserClientHostedPageInventory {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-old',
    browserHostClientId: 'host-a',
    browserHostGeneration: 2,
    browserPageId,
    pageHostGeneration: 3,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    state: 'active',
    currentUrl: `https://remote.internal/${'x'.repeat(4096)}`
  }
}
