import { describe, expect, it } from 'vitest'
import { BrowserRoutePreparedPageLedger } from './browser-route-prepared-page-ledger'

const partition = 'persist:route-a'

describe('BrowserRoutePreparedPageLedger rekey', () => {
  it('moves one exact active authority without changing its capability token', () => {
    const ledger = new BrowserRoutePreparedPageLedger(partition, 4)
    const previous = ledger.link('page-a', 7, 11)
    const nextOwner = {
      partition,
      browserPageId: 'page-a',
      pageHostGeneration: 8,
      rendererWebContentsId: 11
    }

    const next = ledger.rekey(previous, nextOwner)

    expect(next).toMatchObject(nextOwner)
    expect(next?.pageAuthority).toBe(previous.pageAuthority)
    expect(ledger.getAuthority(previous)).toBeNull()
    expect(ledger.getAuthority(nextOwner)).toBe(previous.pageAuthority)
  })

  it('rejects stale, cross-page, cross-renderer, and occupied targets without mutation', () => {
    const ledger = new BrowserRoutePreparedPageLedger(partition, 4)
    const previous = ledger.link('page-a', 7, 11)
    ledger.link('page-a', 8, 11)

    expect(
      ledger.rekey(previous, {
        partition,
        browserPageId: 'page-a',
        pageHostGeneration: 8,
        rendererWebContentsId: 11
      })
    ).toBeNull()
    expect(
      ledger.rekey(previous, {
        partition,
        browserPageId: 'page-b',
        pageHostGeneration: 9,
        rendererWebContentsId: 11
      })
    ).toBeNull()
    expect(
      ledger.rekey(previous, {
        partition,
        browserPageId: 'page-a',
        pageHostGeneration: 9,
        rendererWebContentsId: 12
      })
    ).toBeNull()
    expect(ledger.getAuthority(previous)).toBe(previous.pageAuthority)
  })
})
