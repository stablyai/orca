import {
  BrowserClientHostedPageInventoryList,
  type BrowserClientHostedPageInventory
} from '../../shared/browser-client-host-protocol'

export function snapshotBrowserHostPageInventory(input: {
  browserHostClientId: string
  pageInventoryProtocolVersion?: 1
  pageInventory?: readonly BrowserClientHostedPageInventory[]
}): readonly BrowserClientHostedPageInventory[] | undefined {
  if ((input.pageInventoryProtocolVersion === undefined) !== (input.pageInventory === undefined)) {
    throw new Error('browser_host_page_inventory_negotiation_incomplete')
  }
  if (input.pageInventoryProtocolVersion === undefined || !input.pageInventory) {
    return undefined
  }
  if (input.pageInventoryProtocolVersion !== 1) {
    throw new Error('browser_host_page_inventory_protocol_unsupported')
  }
  const inventory = BrowserClientHostedPageInventoryList.parse(input.pageInventory)
  for (const page of inventory) {
    if (page.browserHostClientId !== input.browserHostClientId) {
      throw new Error('browser_host_page_inventory_authority_mismatch')
    }
    Object.freeze(page)
  }
  return Object.freeze(inventory)
}
