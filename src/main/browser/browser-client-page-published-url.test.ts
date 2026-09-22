import { describe, expect, it } from 'vitest'
import {
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH,
  type BrowserClientHostedPageInventory
} from '../../shared/browser-client-host-protocol'
import { BrowserClientPageMetadataParams } from '../../shared/browser-client-page-metadata-protocol'
import { recordBrowserClientPagePublishedUrl } from './browser-client-page-inventory'

const HOST_CLIENT_ID = 'client-a'
const PAGE_ID = 'page-a'
const PAGE_HOST_GENERATION = 4

const inventory = (
  overrides: Partial<BrowserClientHostedPageInventory> = {}
): BrowserClientHostedPageInventory => ({
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: HOST_CLIENT_ID,
  browserHostGeneration: 3,
  browserPageId: PAGE_ID,
  pageHostGeneration: PAGE_HOST_GENERATION,
  browserProfileId: 'profile-a',
  executionHostKey: `native:runtime-a:1`,
  state: 'active',
  ...overrides
})

const tracked = (
  entry: BrowserClientHostedPageInventory = inventory(),
  generation = PAGE_HOST_GENERATION
) => new Map([[entry.browserPageId, { generation, inventory: entry }]])

const metadata = (overrides: Partial<BrowserClientPageMetadataParams> = {}) => ({
  browserHostClientId: HOST_CLIENT_ID,
  browserHostGeneration: 3,
  browserPageId: PAGE_ID,
  pageHostGeneration: PAGE_HOST_GENERATION,
  revision: 1,
  url: 'https://remote.example/after-navigation',
  title: 'After navigation',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  ...overrides
})

describe('recordBrowserClientPagePublishedUrl', () => {
  it('records the published url on the matching page', () => {
    const pages = tracked()

    recordBrowserClientPagePublishedUrl(pages, metadata())

    expect(pages.get(PAGE_ID)?.inventory.currentUrl).toBe('https://remote.example/after-navigation')
  })

  it('ignores metadata whose pageHostGeneration does not match the tracked page', () => {
    const pages = tracked(inventory({ currentUrl: 'https://remote.example/opened-at' }))

    // A stale generation reports on a page that has since been replaced, not on the one we track.
    recordBrowserClientPagePublishedUrl(pages, metadata({ pageHostGeneration: 99 }))

    expect(pages.get(PAGE_ID)?.inventory.currentUrl).toBe('https://remote.example/opened-at')
  })

  it('ignores metadata for a page id the map does not track', () => {
    const pages = tracked(inventory({ currentUrl: 'https://remote.example/opened-at' }))

    expect(() =>
      recordBrowserClientPagePublishedUrl(pages, metadata({ browserPageId: 'page-unknown' }))
    ).not.toThrow()
    expect(pages.get(PAGE_ID)?.inventory.currentUrl).toBe('https://remote.example/opened-at')
    expect(pages.has('page-unknown')).toBe(false)
  })

  it.each([
    ['an empty object', {}],
    ['undefined', undefined],
    ['a string', 'browser.clientHost.pageMetadata'],
    ['a non-string url', metadata({ url: 42 as unknown as string })],
    ['a generation below the schema floor', metadata({ pageHostGeneration: 0 })]
  ])('ignores params that fail schema validation: %s', (_label, params) => {
    const pages = tracked(inventory({ currentUrl: 'https://remote.example/opened-at' }))

    expect(() => recordBrowserClientPagePublishedUrl(pages, params)).not.toThrow()
    expect(pages.get(PAGE_ID)?.inventory.currentUrl).toBe('https://remote.example/opened-at')
  })

  it('overwrites the recorded url when a newer navigation arrives', () => {
    const pages = tracked(inventory({ currentUrl: 'https://remote.example/opened-at' }))

    recordBrowserClientPagePublishedUrl(
      pages,
      metadata({ revision: 2, url: 'https://a.example/1' })
    )
    recordBrowserClientPagePublishedUrl(
      pages,
      metadata({ revision: 3, url: 'https://a.example/2' })
    )

    expect(pages.get(PAGE_ID)?.inventory.currentUrl).toBe('https://a.example/2')
  })

  it('stores a url exactly at the inventory url cap', () => {
    const pages = tracked()
    const url = `https://remote.example/${'a'.repeat(
      BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH - 'https://remote.example/'.length
    )}`

    recordBrowserClientPagePublishedUrl(pages, metadata({ url }))

    expect(pages.get(PAGE_ID)?.inventory.currentUrl).toHaveLength(
      BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH
    )
  })

  // The metadata schema's url cap equals the inventory cap, so an over-cap url is rejected at parse
  // and never reaches updateBrowserClientPageInventoryCurrentUrl's drop path from this seam.
  it('rejects an over-cap url at schema validation rather than recording it', () => {
    const pages = tracked(inventory({ currentUrl: 'https://remote.example/opened-at' }))
    const url = 'h'.repeat(BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH + 1)

    expect(BrowserClientPageMetadataParams.safeParse(metadata({ url })).success).toBe(false)

    recordBrowserClientPagePublishedUrl(pages, metadata({ url }))

    expect(pages.get(PAGE_ID)?.inventory.currentUrl).toBe('https://remote.example/opened-at')
  })
})
