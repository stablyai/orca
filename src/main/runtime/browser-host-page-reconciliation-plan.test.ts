import { describe, expect, it } from 'vitest'
import {
  planBrowserHostPageReconciliation,
  type BrowserClientHostedPageInventory,
  type BrowserHostRuntimePageIntent
} from './browser-host-page-reconciliation-plan'

const inventorySource = { inventoryPairedDeviceId: 'device-a' }

const currentIntent = (overrides: Partial<BrowserHostRuntimePageIntent> = {}) => ({
  authorityRuntimeId: 'runtime-new',
  authorityEpoch: 'epoch-new',
  browserHostClientId: 'client-a',
  browserHostGeneration: 9,
  browserPageId: 'page-a',
  pageHostGeneration: 12,
  browserProfileId: 'profile-a',
  executionHostKey: 'native:runtime-new:3',
  ...overrides
})

const currentPage = (overrides: Partial<BrowserClientHostedPageInventory> = {}) => ({
  ...currentIntent(),
  state: 'active' as const,
  currentUrl: 'https://remote.example/current',
  ...overrides
})

function inventoryPageAuthority(
  previous: NonNullable<BrowserHostRuntimePageIntent['reclaimFrom']>
) {
  return {
    authorityRuntimeId: previous.authorityRuntimeId,
    authorityEpoch: previous.authorityEpoch,
    browserHostClientId: previous.browserHostClientId,
    browserHostGeneration: previous.browserHostGeneration,
    pageHostGeneration: previous.pageHostGeneration
  }
}

describe('browser host page reconciliation plan', () => {
  it('retains an exact current page without navigation or restoration', () => {
    const intent = currentIntent()
    const page = currentPage()

    const plan = planBrowserHostPageReconciliation([intent], [page], inventorySource)

    expect(plan).toEqual({
      retain: [{ intent, page }],
      reclaim: [],
      close: [],
      restore: [],
      closeThenRestore: []
    })
  })

  it('restores runtime pages missing from authoritative client inventory', () => {
    const intent = currentIntent()

    expect(planBrowserHostPageReconciliation([intent], [], inventorySource)).toEqual({
      retain: [],
      reclaim: [],
      close: [],
      restore: [intent],
      closeThenRestore: []
    })
  })

  it('closes client orphans that have no runtime intent', () => {
    const page = currentPage()

    expect(planBrowserHostPageReconciliation([], [page], inventorySource)).toEqual({
      retain: [],
      reclaim: [],
      close: [page],
      restore: [],
      closeThenRestore: []
    })
  })

  it.each([
    ['profile', { browserProfileId: 'profile-b' }],
    ['execution host', { executionHostKey: 'ssh:target-b:4' }],
    ['authority epoch', { authorityEpoch: 'epoch-stale' }],
    ['host generation', { browserHostGeneration: 8 }],
    ['page generation', { pageHostGeneration: 11 }]
  ])('closes and restores a %s mismatch instead of adopting it', (_label, mismatch) => {
    const intent = currentIntent()
    const page = currentPage(mismatch)

    expect(planBrowserHostPageReconciliation([intent], [page], inventorySource)).toEqual({
      retain: [],
      reclaim: [],
      close: [],
      restore: [],
      closeThenRestore: [{ intent, page }]
    })
  })

  it('reclaims only an exact persisted previous authority on the same runtime', () => {
    const previous = {
      authorityRuntimeId: 'runtime-new',
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'client-a',
      browserHostGeneration: 4,
      pageHostGeneration: 7,
      pairedDeviceId: 'device-a'
    }
    const intent = currentIntent({ reclaimFrom: previous })
    const page = currentPage(inventoryPageAuthority(previous))

    expect(planBrowserHostPageReconciliation([intent], [page], inventorySource)).toEqual({
      retain: [],
      reclaim: [{ intent, page }],
      close: [],
      restore: [],
      closeThenRestore: []
    })
  })

  it.each([
    ['unpersisted authority', undefined],
    ['different old epoch', { authorityEpoch: 'epoch-other' }],
    ['different old host', { browserHostClientId: 'client-b' }],
    ['different old page generation', { pageHostGeneration: 6 }]
  ])('rejects reclaim for a %s', (_label, previousOverride) => {
    const previous = {
      authorityRuntimeId: 'runtime-old',
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'client-a',
      browserHostGeneration: 4,
      pageHostGeneration: 7,
      pairedDeviceId: 'device-a',
      ...previousOverride
    }
    const intent = currentIntent(previousOverride === undefined ? {} : { reclaimFrom: previous })
    const page = currentPage({
      authorityRuntimeId: 'runtime-old',
      authorityEpoch: 'epoch-old',
      browserHostGeneration: 4,
      pageHostGeneration: 7
    })

    expect(planBrowserHostPageReconciliation([intent], [page], inventorySource)).toMatchObject({
      retain: [],
      reclaim: [],
      close: [],
      restore: [],
      closeThenRestore: [{ intent, page }]
    })
  })

  it('does not reclaim an old page onto a different client host', () => {
    const previous = {
      authorityRuntimeId: 'runtime-old',
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'client-a',
      browserHostGeneration: 4,
      pageHostGeneration: 7,
      pairedDeviceId: 'device-a'
    }
    const intent = currentIntent({ browserHostClientId: 'client-b', reclaimFrom: previous })
    const page = currentPage(inventoryPageAuthority(previous))

    expect(
      planBrowserHostPageReconciliation([intent], [page], inventorySource).closeThenRestore
    ).toEqual([{ intent, page }])
  })

  it('rejects reclaim within one authority epoch even when previous identity is exact', () => {
    const previous = {
      authorityRuntimeId: 'runtime-new',
      authorityEpoch: 'epoch-new',
      browserHostClientId: 'client-a',
      browserHostGeneration: 9,
      pageHostGeneration: 12,
      pairedDeviceId: 'device-a'
    }
    const intent = currentIntent({
      browserHostGeneration: 8,
      pageHostGeneration: 11,
      reclaimFrom: previous
    })
    const page = currentPage(inventoryPageAuthority(previous))

    expect(
      planBrowserHostPageReconciliation([intent], [page], inventorySource).closeThenRestore
    ).toEqual([{ intent, page }])
  })

  it('permits generation counters to restart under a new authority epoch', () => {
    const previous = {
      authorityRuntimeId: 'runtime-new',
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'client-a',
      browserHostGeneration: 9,
      pageHostGeneration: 12,
      pairedDeviceId: 'device-a'
    }
    const intent = currentIntent({
      browserHostGeneration: 1,
      pageHostGeneration: 1,
      reclaimFrom: previous
    })
    const page = currentPage(inventoryPageAuthority(previous))

    expect(planBrowserHostPageReconciliation([intent], [page], inventorySource).reclaim).toEqual([
      { intent, page }
    ])
  })

  it('closes and restores an SSH page instead of reclaiming it across runtimes', () => {
    const previous = {
      authorityRuntimeId: 'runtime-old',
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'client-a',
      browserHostGeneration: 4,
      pageHostGeneration: 7,
      pairedDeviceId: 'device-a'
    }
    const intent = currentIntent({
      executionHostKey: JSON.stringify(['ssh', 'target-a', 'provider-a', 3]),
      reclaimFrom: previous
    })
    const page = currentPage({
      ...inventoryPageAuthority(previous),
      executionHostKey: intent.executionHostKey
    })

    expect(
      planBrowserHostPageReconciliation([intent], [page], inventorySource).closeThenRestore
    ).toEqual([{ intent, page }])
  })

  it('rejects restart reclaim from a different authenticated paired device', () => {
    const previous = {
      authorityRuntimeId: 'runtime-old',
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'client-a',
      browserHostGeneration: 4,
      pageHostGeneration: 7,
      pairedDeviceId: 'device-a'
    }
    const intent = currentIntent({ reclaimFrom: previous })
    const page = currentPage(inventoryPageAuthority(previous))

    expect(
      planBrowserHostPageReconciliation([intent], [page], {
        inventoryPairedDeviceId: 'device-b'
      }).closeThenRestore
    ).toEqual([{ intent, page }])
  })

  it('never retains or reclaims an outcome-unknown page', () => {
    const intent = currentIntent({
      reclaimFrom: {
        authorityRuntimeId: 'runtime-new',
        authorityEpoch: 'epoch-new',
        browserHostClientId: 'client-a',
        browserHostGeneration: 9,
        pageHostGeneration: 12,
        pairedDeviceId: 'device-a'
      }
    })
    const page = currentPage({ state: 'outcomeUnknown' })

    expect(planBrowserHostPageReconciliation([intent], [page], inventorySource)).toEqual({
      retain: [],
      reclaim: [],
      close: [],
      restore: [],
      closeThenRestore: [{ intent, page }]
    })
  })

  it.each([
    ['runtime intent', [currentIntent(), currentIntent()], []],
    ['client inventory', [], [currentPage(), currentPage()]]
  ])('rejects duplicate page IDs in %s', (_label, intents, pages) => {
    expect(() => planBrowserHostPageReconciliation(intents, pages, inventorySource)).toThrow(
      'browser_host_page_reconciliation_duplicate'
    )
  })

  it('rejects over-capacity inventories before returning a partial plan', () => {
    expect(() =>
      planBrowserHostPageReconciliation(
        [currentIntent(), currentIntent({ browserPageId: 'page-b' })],
        [],
        { ...inventorySource, maxPages: 1 }
      )
    ).toThrow('browser_host_page_reconciliation_capacity')
  })

  it.each([
    ['empty identity', currentIntent({ browserPageId: '' }), 'identity'],
    ['oversized identity', currentIntent({ browserPageId: 'p'.repeat(257) }), 'identity'],
    ['zero generation', currentIntent({ pageHostGeneration: 0 }), 'generation'],
    ['oversized generation', currentIntent({ pageHostGeneration: 0x1_0000_0000 }), 'generation']
  ])('rejects %s', (_label, intent, errorKind) => {
    expect(() => planBrowserHostPageReconciliation([intent], [], inventorySource)).toThrow(
      `browser_host_page_reconciliation_${errorKind}_invalid`
    )
  })

  it('rejects oversized URLs and unknown client page states', () => {
    expect(() =>
      planBrowserHostPageReconciliation(
        [],
        [currentPage({ currentUrl: 'u'.repeat(8193) })],
        inventorySource
      )
    ).toThrow('browser_host_page_reconciliation_url_invalid')
    const invalidState = { ...currentPage(), state: 'other' }
    expect(() =>
      planBrowserHostPageReconciliation(
        [],
        [invalidState as unknown as BrowserClientHostedPageInventory],
        inventorySource
      )
    ).toThrow('browser_host_page_reconciliation_state_invalid')
  })

  it.each([0, 257])('rejects invalid max page limit %s', (maxPages) => {
    expect(() =>
      planBrowserHostPageReconciliation([], [], { ...inventorySource, maxPages })
    ).toThrow('browser_host_page_reconciliation_limit_invalid')
  })

  it('returns immutable records and action lists', () => {
    const plan = planBrowserHostPageReconciliation(
      [currentIntent()],
      [currentPage()],
      inventorySource
    )

    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.retain)).toBe(true)
    expect(Object.isFrozen(plan.retain[0])).toBe(true)
  })
})
