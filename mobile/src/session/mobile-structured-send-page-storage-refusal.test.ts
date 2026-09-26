import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page's own AsyncStorage under the durable send journal, which is the one allowlisted value
 * that outgrows what the bridge will carry.
 *
 * Measured on this tree: a journal entry with no attachment costs 343 characters in the array —
 * 342 of its own plus the comma that joins it — and the schema admits 4,096 of them, so 47
 * unsettled sends measure 16,140 and 48 measure 16,483, past `PAGE_STORAGE_MAX_VALUE_CHARS`. Every
 * page write goes through `page-async-storage`, which the
 * bundler aliases over the real module, so this is the module the journal actually writes to
 * inside the page — and the reason the refusal must be a rejection rather than a dropped write.
 *
 * What a resolved refusal would cost, which is more than a lost preference: the journal would
 * answer with an operation id no store holds, the mutation would go out carrying it, and a retry
 * after a crash would send the same message again. Ruling 7's "nothing silently no-ops", at the
 * one key where silence is a duplicate message rather than a default.
 *
 * The other half of the chain — that the rejection reaches the composer as "Message not sent" — is
 * in `use-mobile-structured-agent-session-send.test.tsx`, which already drives the real send with
 * a client double; asserting it here would mean building a second one.
 */
vi.mock('@react-native-async-storage/async-storage', async () => ({
  default: (await import('../mobile-web-shell/bridge/page-async-storage')).default
}))

const { publishPageStorage } = await import('../mobile-web-shell/bridge/page-async-storage')
const { PAGE_STORAGE_MAX_VALUE_CHARS, pageStorageEntriesForInit } =
  await import('../mobile-web-shell/page-storage-keys')
const {
  getOrCreateMobileStructuredSendOperation,
  resetMobileStructuredSendOperationJournalForTests
} = await import('./mobile-structured-send-operation-journal')

const HOST_ID = 'host-1'
const SESSION_ROUTE = '/h/host-1/session/wt-1'
const JOURNAL = 'orca:mobileStructuredSendOperations:v1'

const hex = (fill: string) => fill.repeat(64)

/**
 * A journal the module itself reads back, built past the cap out of real entries rather than
 * filler: a value the parser refuses reads as "unreadable" and never reaches the write at all.
 * `ENTRIES_OVER_THE_CAP` is the measured number — one entry costs 343 characters in the array.
 */
const ENTRIES_OVER_THE_CAP = 48

function storedJournal(count: number): string {
  return JSON.stringify({
    v: 1,
    entries: Array.from({ length: count }, (_, index) => ({
      operationKey: index.toString(16).padStart(64, '0'),
      operationId: `17584320${String(index).padStart(5, '0')}-${'b'.repeat(32)}`,
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

function publish(entries: Record<string, string>): void {
  publishAsTheShellWould(entries)
}

function claim() {
  return getOrCreateMobileStructuredSendOperation({
    operationKey: hex('a'),
    callerIdentity: 'caller-1',
    payloadFingerprint: hex('d'),
    attachmentPaths: [],
    createOperationId: () => `${String(Date.now())}-${hex('b').slice(0, 32)}`
  })
}

beforeEach(() => {
  resetMobileStructuredSendOperationJournalForTests()
  publish({})
})

describe('the durable send journal against the page store', () => {
  it('rejects the send that would take the journal past what the page may write', async () => {
    // The real precondition, seated through the shell's own split: 47 entries fit, so `init`
    // carries them and the page holds a journal it can read. The 48th is the one that does not.
    const held = storedJournal(ENTRIES_OVER_THE_CAP - 1)
    expect(held.length).toBeLessThanOrEqual(PAGE_STORAGE_MAX_VALUE_CHARS)
    expect(storedJournal(ENTRIES_OVER_THE_CAP).length).toBeGreaterThan(PAGE_STORAGE_MAX_VALUE_CHARS)
    publishAsTheShellWould({ [JOURNAL]: held })
    await expect(claim()).rejects.toThrow(/could not save/)
    // Nothing posted either: the value the wire would have dropped never left the page.
    expect(posted).toEqual([])
  })

  /**
   * The destructive one (ruling 33.6).
   *
   * A native journal past the cap is dropped from `init` for size, and the key stays in
   * `pageStorageKeysForRoute`. Without the oversize list the page reads `null`, `parseJournal`
   * answers an empty journal, and the first send writes a one-entry value over the device's — the
   * native entries gone and a fresh `operationId` for an operation native already holds, which is
   * the duplicate send ruling 7 exists to prevent.
   */
  it('refuses a send when init could not carry the journal, instead of replacing it', async () => {
    const held = storedJournal(ENTRIES_OVER_THE_CAP)
    const { entries, oversize } = pageStorageEntriesForInit({ [JOURNAL]: held })
    // The precondition itself: the shell hands no value for this key and names it instead.
    expect(entries).toEqual({})
    expect(oversize).toEqual([JOURNAL])
    publishAsTheShellWould({ [JOURNAL]: held })
    await expect(claim()).rejects.toThrow(/could not save/)
    // The half that makes it destructive: nothing was posted, so the native journal is untouched.
    expect(posted).toEqual([])
  })

  it('claims an id when the journal fits, so the refusal above is the size and not the path', async () => {
    publish({})
    await expect(claim()).resolves.toEqual(expect.objectContaining({ retained: false }))
    expect(posted.map((write) => write.key)).toEqual([JOURNAL])
  })
})
