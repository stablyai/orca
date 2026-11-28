import { expect, it } from 'vitest'
import { BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { createBrowserClientPageInventory } from './browser-client-page-inventory'

function createPageEvent(
  initialUrl: string
): Parameters<typeof createBrowserClientPageInventory>[0] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory reads only these createPage fields.
  return {
    authorityRuntimeId: 'runtime',
    authorityEpoch: 1,
    browserHostClientId: 'client',
    browserHostGeneration: 1,
    browserPageId: 'page',
    pageHostGeneration: 1,
    command: {
      type: 'createPage',
      browserProfileId: 'default',
      executionHostKey: 'host',
      initialUrl
    }
  } as never
}

it('stores a redacted initial URL only when the redacted form fits the inventory limit', () => {
  // Redaction percent-encodes the path, so a URL under the limit can exceed it once redacted.
  const growing = `https://kagi.com/${'é'.repeat(1400)}?token=secret`
  expect(growing.length).toBeLessThan(BROWSER_CLIENT_HOST_PAGE_INVENTORY_URL_MAX_LENGTH)
  expect(createBrowserClientPageInventory(createPageEvent(growing), 'active')).not.toHaveProperty(
    'currentUrl'
  )
  expect(
    createBrowserClientPageInventory(
      createPageEvent('https://kagi.com/search?q=one&token=secret'),
      'active'
    ).currentUrl
  ).toBe('https://kagi.com/search?q=one')
})
