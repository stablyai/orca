import { describe, expect, it } from 'vitest'
import { BOTS_ITEM_LINKS_RUNTIME_CAPABILITY } from '../../shared/bot-runtime-capabilities'
import { assertItemLinkRefsSupported } from './bot-item-link-refs'

type Client = Parameters<typeof assertItemLinkRefsSupported>[0]

function host(capabilities: string[]): Client {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only status.get is called.
  return { call: async () => ({ result: { capabilities } }) } as unknown as Client
}

describe('item: refs on an older host', () => {
  it('refuses an item: ref only where the host lacks item links', async () => {
    await expect(
      assertItemLinkRefsSupported(host([]), ['https://example.com', ' item:4'])
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    await expect(
      assertItemLinkRefsSupported(host([]), ['dispatch:ctx_1', 'pr:acme/app#1', 'notes/item:4.md'])
    ).resolves.toBeUndefined()
    await expect(
      assertItemLinkRefsSupported(host([BOTS_ITEM_LINKS_RUNTIME_CAPABILITY]), ['item:4'])
    ).resolves.toBeUndefined()
  })
})
