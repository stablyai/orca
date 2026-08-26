import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'

const DEFAULT_MAX_PAGES = 256
const MAX_GENERATION = 0xffff_ffff
const MAX_IDENTITY_LENGTH = 256
const MAX_URL_LENGTH = 8192

export type BrowserHostPageAuthority = Readonly<{
  authorityRuntimeId: string
  authorityEpoch: string
  browserHostClientId: string
  browserHostGeneration: number
  pageHostGeneration: number
}>

export type BrowserHostRuntimePageIntent = BrowserHostPageAuthority &
  Readonly<{
    browserPageId: string
    browserProfileId: string
    executionHostKey: string
    /** Round-tripped to the client so the page's inventory keeps naming its workspace. */
    workspaceId?: string
    reclaimFrom?: BrowserHostPageAuthority & Readonly<{ pairedDeviceId: string }>
  }>

export type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'

type PagePair = Readonly<{
  intent: BrowserHostRuntimePageIntent
  page: BrowserClientHostedPageInventory
}>

export type BrowserHostPageReconciliationPlan = Readonly<{
  retain: readonly PagePair[]
  reclaim: readonly PagePair[]
  close: readonly BrowserClientHostedPageInventory[]
  restore: readonly BrowserHostRuntimePageIntent[]
  closeThenRestore: readonly PagePair[]
}>

export function planBrowserHostPageReconciliation(
  intentInput: readonly BrowserHostRuntimePageIntent[],
  pageInput: readonly BrowserClientHostedPageInventory[],
  options: { inventoryPairedDeviceId: string; maxPages?: number }
): BrowserHostPageReconciliationPlan {
  assertIdentity(options.inventoryPairedDeviceId)
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  assertCapacity(maxPages, intentInput.length, pageInput.length)
  const intents = freezeUniqueRecords(intentInput, freezeIntent)
  const pages = freezeUniqueRecords(pageInput, freezePage)
  const pagesById = new Map(pages.map((page) => [page.browserPageId, page]))
  const consumedPageIds = new Set<string>()
  const retain: PagePair[] = []
  const reclaim: PagePair[] = []
  const close: BrowserClientHostedPageInventory[] = []
  const restore: BrowserHostRuntimePageIntent[] = []
  const closeThenRestore: PagePair[] = []

  for (const intent of intents) {
    const page = pagesById.get(intent.browserPageId)
    if (!page) {
      restore.push(intent)
      continue
    }
    consumedPageIds.add(page.browserPageId)
    if (page.state === 'active' && sameCurrentPage(intent, page)) {
      retain.push(Object.freeze({ intent, page }))
      continue
    }
    if (page.state === 'active' && canReclaimPage(intent, page, options.inventoryPairedDeviceId)) {
      reclaim.push(Object.freeze({ intent, page }))
      continue
    }
    closeThenRestore.push(Object.freeze({ intent, page }))
  }
  for (const page of pages) {
    if (!consumedPageIds.has(page.browserPageId)) {
      close.push(page)
    }
  }

  return Object.freeze({
    retain: Object.freeze(retain),
    reclaim: Object.freeze(reclaim),
    close: Object.freeze(close),
    restore: Object.freeze(restore),
    closeThenRestore: Object.freeze(closeThenRestore)
  })
}

function sameCurrentPage(
  intent: BrowserHostRuntimePageIntent,
  page: BrowserClientHostedPageInventory
): boolean {
  return (
    sameAuthority(intent, page) &&
    intent.browserProfileId === page.browserProfileId &&
    intent.executionHostKey === page.executionHostKey
  )
}

function canReclaimPage(
  intent: BrowserHostRuntimePageIntent,
  page: BrowserClientHostedPageInventory,
  inventoryPairedDeviceId: string
): boolean {
  return Boolean(
    intent.reclaimFrom &&
    intent.reclaimFrom.pairedDeviceId === inventoryPairedDeviceId &&
    intent.authorityEpoch !== intent.reclaimFrom.authorityEpoch &&
    intent.authorityRuntimeId === intent.reclaimFrom.authorityRuntimeId &&
    sameAuthority(intent.reclaimFrom, page) &&
    intent.browserHostClientId === intent.reclaimFrom.browserHostClientId &&
    intent.browserProfileId === page.browserProfileId &&
    intent.executionHostKey === page.executionHostKey
  )
}

function sameAuthority(left: BrowserHostPageAuthority, right: BrowserHostPageAuthority): boolean {
  return (
    left.authorityRuntimeId === right.authorityRuntimeId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration &&
    left.pageHostGeneration === right.pageHostGeneration
  )
}

function freezeUniqueRecords<T extends { browserPageId: string }>(
  records: readonly T[],
  freeze: (record: T) => T
): readonly T[] {
  const seen = new Set<string>()
  return records.map((record) => {
    assertIdentity(record.browserPageId)
    if (seen.has(record.browserPageId)) {
      throw new Error('browser_host_page_reconciliation_duplicate')
    }
    seen.add(record.browserPageId)
    return freeze(record)
  })
}

function freezeIntent(intent: BrowserHostRuntimePageIntent): BrowserHostRuntimePageIntent {
  assertPageRecord(intent)
  if (intent.reclaimFrom) {
    assertAuthority(intent.reclaimFrom)
    assertIdentity(intent.reclaimFrom.pairedDeviceId)
  }
  return Object.freeze({
    ...intent,
    ...(intent.reclaimFrom ? { reclaimFrom: Object.freeze({ ...intent.reclaimFrom }) } : {})
  })
}

function freezePage(page: BrowserClientHostedPageInventory): BrowserClientHostedPageInventory {
  assertPageRecord(page)
  if (page.state !== 'active' && page.state !== 'outcomeUnknown') {
    throw new Error('browser_host_page_reconciliation_state_invalid')
  }
  if (
    page.currentUrl !== undefined &&
    (typeof page.currentUrl !== 'string' || page.currentUrl.length > MAX_URL_LENGTH)
  ) {
    throw new Error('browser_host_page_reconciliation_url_invalid')
  }
  return Object.freeze({ ...page })
}

function assertPageRecord(
  record: BrowserHostPageAuthority & {
    browserPageId: string
    browserProfileId: string
    executionHostKey: string
  }
): void {
  assertAuthority(record)
  assertIdentity(record.browserPageId)
  assertIdentity(record.browserProfileId)
  assertIdentity(record.executionHostKey)
}

function assertAuthority(authority: BrowserHostPageAuthority): void {
  assertIdentity(authority.authorityRuntimeId)
  assertIdentity(authority.authorityEpoch)
  assertIdentity(authority.browserHostClientId)
  assertGeneration(authority.browserHostGeneration)
  assertGeneration(authority.pageHostGeneration)
}

function assertIdentity(identity: string): void {
  if (
    typeof identity !== 'string' ||
    identity.length === 0 ||
    identity.length > MAX_IDENTITY_LENGTH
  ) {
    throw new Error('browser_host_page_reconciliation_identity_invalid')
  }
}

function assertGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
    throw new Error('browser_host_page_reconciliation_generation_invalid')
  }
}

function assertCapacity(maxPages: number, intentCount: number, pageCount: number): void {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > DEFAULT_MAX_PAGES) {
    throw new Error('browser_host_page_reconciliation_limit_invalid')
  }
  if (intentCount > maxPages || pageCount > maxPages) {
    throw new Error('browser_host_page_reconciliation_capacity')
  }
}
