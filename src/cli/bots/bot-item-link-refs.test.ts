import { describe, expect, it, vi } from 'vitest'
import { BOTS_ITEM_LINKS_RUNTIME_CAPABILITY } from '../../shared/bot-runtime-capabilities'
import { assertItemLinkRefsSupported } from './bot-item-link-refs'

function host(capabilities: string[]) {
  const call = vi.fn(async () => ({ result: { capabilities } }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only status.get is called.
  return { call } as unknown as Parameters<typeof assertItemLinkRefsSupported>[0] & {
    call: typeof call
  }
}

describe('item: refs on an older host', () => {
  it('refuses an item: ref where the host lacks item links, and asks nothing for other refs', async () => {
    const older = host([])
    await expect(
      assertItemLinkRefsSupported(older, ['https://example.com', ' item:4'])
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    await assertItemLinkRefsSupported(older, ['dispatch:ctx_1', 'pr:acme/app#1', 'notes/item:4.md'])
    expect(older.call).toHaveBeenCalledTimes(1)

    const current = host([BOTS_ITEM_LINKS_RUNTIME_CAPABILITY])
    await expect(assertItemLinkRefsSupported(current, ['item:4'])).resolves.toBeUndefined()
  })
})
