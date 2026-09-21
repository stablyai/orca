import { describe, expect, it } from 'vitest'
import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import { prepareBrowserClientPageInventoryForAttach } from './browser-client-page-inventory'

describe('browser client page inventory', () => {
  it('uses codepoint order to break equal URL-compaction ties across input order', () => {
    const pageIds = [
      'ä-page',
      'z-page',
      ...Array.from({ length: 254 }, (_, index) => `page-${index.toString().padStart(3, '0')}`)
    ]
    const inventory = pageIds.map(inventoryPage)
    const forward = prepareBrowserClientPageInventoryForAttach(inventory)
    const reversed = prepareBrowserClientPageInventoryForAttach(inventory.toReversed())
    if (!forward || !reversed) {
      throw new Error('expected encodable inventory')
    }
    const omitted = omittedPageIds(forward)
    const expected = [...pageIds].sort(compareCodepoints).slice(0, omitted.length)

    expect(omitted.length).toBeGreaterThan(0)
    expect(omitted).toEqual(expected)
    expect(omittedPageIds(reversed)).toEqual(expected)
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

function omittedPageIds(pages: readonly BrowserClientHostedPageInventory[]): string[] {
  return pages
    .filter((page) => page.currentUrl === undefined)
    .map((page) => page.browserPageId)
    .sort(compareCodepoints)
}

function compareCodepoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
