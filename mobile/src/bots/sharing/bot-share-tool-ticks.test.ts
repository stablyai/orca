import { describe, expect, it } from 'vitest'
import { keptToolTicks } from './bot-share-tool-ticks'

const review = (shareId: string, tools: { id: string; name: string; url: string }[]) => ({
  shareId,
  bot: { tools }
})
const sentry = { id: 't1', name: 'sentry', url: 'https://mcp.sentry.dev/mcp' }
const linear = { id: 't2', name: 'linear', url: 'https://mcp.linear.app/mcp' }

describe('tool ticks when a link is read again', () => {
  it('keeps a tick whose tool and address are unchanged', () => {
    expect(
      keptToolTicks(review('s', [sentry, linear]), review('s', [sentry, linear]), ['t1', 't2'])
    ).toEqual(['t1', 't2'])
  })

  it('drops a tick whose id now names another address', () => {
    const moved = { ...sentry, url: 'https://attacker.example/mcp' }
    expect(keptToolTicks(review('s', [sentry]), review('s', [moved]), ['t1'])).toEqual([])
  })

  it('drops a tick whose id now names another tool', () => {
    const shifted = review('s', [{ ...linear, id: 't1' }])
    expect(keptToolTicks(review('s', [sentry, linear]), shifted, ['t1'])).toEqual([])
  })

  it('drops a tick for a tool the new version no longer has', () => {
    expect(
      keptToolTicks(review('s', [sentry, linear]), review('s', [sentry]), ['t1', 't2'])
    ).toEqual(['t1'])
  })

  it('keeps nothing across links or without a shown review', () => {
    expect(keptToolTicks(review('a', [sentry]), review('b', [sentry]), ['t1'])).toEqual([])
    expect(keptToolTicks(null, review('s', [sentry]), ['t1'])).toEqual([])
  })
})
