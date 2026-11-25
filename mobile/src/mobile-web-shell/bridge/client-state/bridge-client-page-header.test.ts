import { describe, expect, it, vi } from 'vitest'
import { pageHeaderPayload } from '../../../platform/page-header/page-header-payload'
import { createBridgeClientPageHeader } from './bridge-client-page-header'

describe('createBridgeClientPageHeader', () => {
  it('drops a press made on a header the page has since replaced', () => {
    const removed = vi.fn()
    const survivor = vi.fn()
    const request = (items: { label: string; onPress: () => void }[]) =>
      pageHeaderPayload({
        title: 'Host',
        actions: [{ id: 'more', label: 'More', menu: [items] }]
      })
    const before = request([
      { label: 'Edit', onPress: removed },
      { label: 'Edit', onPress: survivor }
    ])
    const after = request([{ label: 'Edit', onPress: survivor }])
    if (!before || !after) {
      throw new Error('header not drawable')
    }
    const pageHeader = createBridgeClientPageHeader(() => {})
    let handlers = before.handlers
    const claim = pageHeader.claim(before.header, (actionId) => handlers.get(actionId)?.())
    handlers = after.handlers
    claim.update(after.header)

    pageHeader.accept('more/Edit', 1)
    expect(removed).not.toHaveBeenCalled()
    expect(survivor).not.toHaveBeenCalled()

    pageHeader.accept('more/Edit', 2)
    expect(survivor).toHaveBeenCalledOnce()
  })
})
