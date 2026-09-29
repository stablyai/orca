import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page's own AsyncStorage under the v1 send journal, which older builds and host-served pages
 * wrote and which this build only drains.
 *
 * Measured on this tree: a journal entry with no attachment costs 343 characters in the array, so
 * 47 unsettled sends fit `PAGE_STORAGE_MAX_VALUE_CHARS` and 48 do not. A journal past the cap
 * reaches the page as a name on the oversize list rather than a value, and the page must not write
 * over the device's copy with what it believes is an empty one.
 */
vi.mock('@react-native-async-storage/async-storage', async () => ({
  default: (await import('../mobile-web-shell/bridge/page-async-storage')).default
}))

const { publishPageStorage } = await import('../mobile-web-shell/bridge/page-async-storage')
const { PAGE_STORAGE_MAX_VALUE_CHARS, pageStorageEntriesForInit } =
  await import('../mobile-web-shell/page-storage-keys')
const {
  reconcileMobileStructuredSendOperations,
  resetMobileStructuredSendOperationJournalForTests
} = await import('./mobile-structured-send-operation-journal')

const HOST_ID = 'host-1'
const SESSION_ROUTE = '/h/host-1/session/wt-1'
const JOURNAL = 'orca:mobileStructuredSendOperations:v1'

const NOW = 1_758_432_000_000
const hex = (fill: string) => fill.repeat(64)
const operationIdAt = (index: number) => `${String(NOW - index)}-${'b'.repeat(32)}`

/**
 * A journal the module itself reads back, built past the cap out of real entries rather than
 * filler: a value the parser refuses reads as "unreadable" and never reaches the write at all.
 * `ENTRIES_OVER_THE_CAP` is the measured number — one entry costs 343 characters in the array.
 */
const ENTRIES_OVER_THE_CAP = 48

function storedJournal(count: number, from = 0): string {
  return JSON.stringify({
    v: 1,
    entries: Array.from({ length: count - from }, (_, offset) => from + offset).map((index) => ({
      operationKey: index.toString(16).padStart(64, '0'),
      operationId: operationIdAt(index),
      callerFingerprint: hex('c'),
      payloadFingerprint: hex('d'),
      attachmentPaths: []
    }))
  })
}

const posted: { key: string; value: string | null }[] = []

/**
 * The page seated the way the shell seats it, rather than from a hand-written record.
 *
 * `pageStorageEntriesForInit` is the split the shell runs before `init` is built, so driving the
 * page through it is what makes these states ones production can reach: a journal over the cap
 * never arrives as a value, it arrives as a name on the oversize list.
 */
function publishAsTheShellWould(held: Record<string, string>): void {
  posted.length = 0
  const { entries, oversize } = pageStorageEntriesForInit(held)
  publishPageStorage(
    entries,
    (key, value) => {
      posted.push({ key, value })
      return true
    },
    HOST_ID,
    SESSION_ROUTE,
    oversize
  )
}

/** The host settling the first stored entry, so reconciliation has a write to make. */
function reconcileFirst() {
  return reconcileMobileStructuredSendOperations({
    submissions: [
      {
        clientMessageId: operationIdAt(0),
        fence: 1,
        payloadFingerprint: hex('d'),
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: NOW,
        resolvedAt: NOW
      }
    ],
    now: NOW
  })
}

beforeEach(() => {
  resetMobileStructuredSendOperationJournalForTests()
  publishAsTheShellWould({})
})

describe('the v1 send journal against the page store', () => {
  it('reconciles a journal init carried, through the page store', async () => {
    const held = storedJournal(ENTRIES_OVER_THE_CAP - 1)
    expect(held.length).toBeLessThanOrEqual(PAGE_STORAGE_MAX_VALUE_CHARS)
    publishAsTheShellWould({ [JOURNAL]: held })
    await reconcileFirst()
    expect(posted).toEqual([{ key: JOURNAL, value: storedJournal(ENTRIES_OVER_THE_CAP - 1, 1) }])
  })

  /**
   * The destructive one (ruling 33.6): the page holds no value for a journal init could not carry,
   * so anything it wrote would replace the device's entries rather than edit them.
   */
  it('leaves a journal init could not carry alone', async () => {
    const held = storedJournal(ENTRIES_OVER_THE_CAP)
    const { entries, oversize } = pageStorageEntriesForInit({ [JOURNAL]: held })
    expect(entries).toEqual({})
    expect(oversize).toEqual([JOURNAL])
    publishAsTheShellWould({ [JOURNAL]: held })
    await reconcileFirst()
    expect(posted).toEqual([])
  })
})
