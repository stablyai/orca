import { beforeEach, describe, expect, it } from 'vitest'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from '../page-storage-keys'
import pageAsyncStorage, { PageStorageRefusedError, publishPageStorage } from './page-async-storage'

type Write = { key: string; value: string | null }

const writes: Write[] = []
let granted = true

const HOST_ID = 'host-1'
const SESSION_ROUTE = '/h/host-1/session/wt-1'

function publish(entries: Record<string, string> = {}): void {
  writes.length = 0
  publishPageStorage(
    entries,
    (key, value) => {
      if (!granted) {
        return false
      }
      writes.push({ key, value })
      return true
    },
    HOST_ID,
    SESSION_ROUTE
  )
}

/** The refusal a caller's own catch reads, as this file asserts it everywhere below. */
async function refusalOf(write: Promise<void>): Promise<PageStorageRefusedError> {
  try {
    await write
  } catch (error) {
    if (error instanceof PageStorageRefusedError) {
      return error
    }
    throw error
  }
  throw new Error('the write was not refused')
}

beforeEach(() => {
  granted = true
  publish()
})

describe('what init primed', () => {
  it('answers a read without waiting on the shell', async () => {
    publish({ 'orca:pins:host-1': '["wt-1"]' })
    // Synchronous against the cache behind an async surface: a read that waited for a round trip
    // would change what the first render sees, which is a moved golden.
    await expect(pageAsyncStorage.getItem('orca:pins:host-1')).resolves.toBe('["wt-1"]')
    await expect(pageAsyncStorage.getItem('orca:pins:host-2')).resolves.toBeNull()
  })

  it('reads several keys at once, which is how the list asks', async () => {
    publish({ 'orca:pins:host-1': '["wt-1"]' })
    await expect(
      pageAsyncStorage.multiGet(['orca:pins:host-1', 'orca:last-visited-worktree'])
    ).resolves.toEqual([
      ['orca:pins:host-1', '["wt-1"]'],
      ['orca:last-visited-worktree', null]
    ])
  })

  it('replaces what the last page held rather than adding to it', async () => {
    publish({ 'orca:pins:host-1': '["wt-1"]' })
    publish({ 'orca:pins:host-2': '["wt-2"]' })
    await expect(pageAsyncStorage.getItem('orca:pins:host-1')).resolves.toBeNull()
  })
})

describe('a write the page makes', () => {
  it('goes to the app, and is readable here at once', async () => {
    await pageAsyncStorage.setItem('orca:pins:host-1', '["wt-1","wt-2"]')
    expect(writes).toEqual([{ key: 'orca:pins:host-1', value: '["wt-1","wt-2"]' }])
    await expect(pageAsyncStorage.getItem('orca:pins:host-1')).resolves.toBe('["wt-1","wt-2"]')
  })

  it('removes by writing null, which is what the app then deletes', async () => {
    publish({ 'orca:pins:host-1': '["wt-1"]' })
    await pageAsyncStorage.removeItem('orca:pins:host-1')
    expect(writes).toEqual([{ key: 'orca:pins:host-1', value: null }])
    await expect(pageAsyncStorage.getItem('orca:pins:host-1')).resolves.toBeNull()
  })

  it('is dropped, and not kept, for a key outside the allowlist', async () => {
    // Held locally it would answer a later read with a value no other screen in the app can see —
    // a pin that looks set and is not, which is the failure the grant exists to avoid. Dropped
    // rather than rejected: ruling 33.4, and the case at the end of this file says why.
    await expect(
      pageAsyncStorage.setItem('orca:mobileWebShellEnabled', 'true')
    ).resolves.toBeUndefined()
    expect(writes).toEqual([])
    await expect(pageAsyncStorage.getItem('orca:mobileWebShellEnabled')).resolves.toBeNull()
  })

  it('carries each pair of a multi-write up to the first it cannot, and no further', async () => {
    await expect(
      pageAsyncStorage.multiSet([
        ['orca:pins:host-1', '["wt-1"]'],
        ['orca:remotePushHostRegistrations', '{}']
      ])
    ).resolves.toBeUndefined()
    // Everything before the refusal is applied, and the refusal is where the batch ends: one call
    // with one answer (ruling 35), rather than a promise describing a half-applied batch.
    expect(writes).toEqual([{ key: 'orca:pins:host-1', value: '["wt-1"]' }])
  })

  it('stops a multi-write at a refused first pair rather than applying the rest behind it', async () => {
    await expect(
      pageAsyncStorage.multiSet([
        ['orca:remotePushHostRegistrations', '{}'],
        ['orca:pins:host-1', '["wt-1"]']
      ])
    ).resolves.toBeUndefined()
    expect(writes).toEqual([])
  })

  it('never empties the app store, which is not this document to empty', async () => {
    publish({ 'orca:pins:host-1': '["wt-1"]' })
    await pageAsyncStorage.clear()
    expect(writes).toEqual([])
    await expect(pageAsyncStorage.getItem('orca:pins:host-1')).resolves.toBe('["wt-1"]')
  })
})

describe('what the page will not keep', () => {
  it("drops another host's pinned list, so a later read cannot answer with it", async () => {
    publish({ 'orca:pins:host-1': '["mine"]' })
    await expect(
      pageAsyncStorage.setItem('orca:pins:host-2', '["theirs"]')
    ).resolves.toBeUndefined()
    // Nothing posted, and nothing cached: a value held here that the shell will not write is a pin
    // that looks set to this document and to nothing else in the app.
    expect(writes).toEqual([])
    expect(await pageAsyncStorage.getItem('orca:pins:host-2')).toBeNull()
  })

  it("drops another workspace's chat tabs on the session route it was not opened for", async () => {
    publish()
    await expect(
      pageAsyncStorage.setItem('orca:nativeChatTabs:host-1:wt-2', '{}')
    ).resolves.toBeUndefined()
    expect(writes).toEqual([])
    // And the one it was opened for goes through, so the drop above is about the workspace.
    await pageAsyncStorage.setItem('orca:nativeChatTabs:host-1:wt-1', '{}')
    expect(writes).toEqual([{ key: 'orca:nativeChatTabs:host-1:wt-1', value: '{}' }])
  })

  it('refuses a value over the envelope bound rather than caching what the wire will drop', async () => {
    publish()
    const oversized = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1)
    const refusal = await refusalOf(
      pageAsyncStorage.setItem('orca:mobileStructuredSendOperations:v1', oversized)
    )
    // The sentence a screen puts on itself, which is what ruling 7 asks for: the durable send
    // journal outgrows the bound at 48 unsettled sends, and vanishing is what it must not do.
    expect(refusal.refusal).toBe('too-large')
    expect(refusal.message).toContain('orca:mobileStructuredSendOperations:v1')
    expect(refusal.message).toContain(String(PAGE_STORAGE_MAX_VALUE_CHARS))
    expect(writes).toEqual([])
    expect(await pageAsyncStorage.getItem('orca:mobileStructuredSendOperations:v1')).toBeNull()
  })

  /**
   * A batch with two oversize pairs, which is one rejection and not two.
   *
   * `settleBatch` returned the first rejected promise and dropped the rest, so every later
   * oversize entry was a rejected promise nobody held — an unhandled rejection in the page, which
   * is the outcome this module's rejection scope exists to avoid.
   */
  it('rejects a batch of two oversize pairs once, leaving no rejection nobody holds', async () => {
    publish()
    const unhandled: unknown[] = []
    const record = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    const oversized = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1)
    const refusal = await refusalOf(
      pageAsyncStorage.multiSet([
        ['orca:mobileStructuredSendOperations:v1', oversized],
        ['orca:custom-accessory-keys', oversized]
      ])
    )
    // Two turns, which is when an orphaned rejection is reported.
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', record)
    expect(unhandled).toEqual([])
    // The first pair is the one the caller is told about, and neither reached the wire.
    expect(refusal.key).toBe('orca:mobileStructuredSendOperations:v1')
    expect(writes).toEqual([])
  })

  it('still keeps a value exactly at the bound, so the refusal above discriminates', async () => {
    publish()
    const atBound = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS)
    await pageAsyncStorage.setItem('orca:last-visited-worktree', atBound)
    expect(writes).toEqual([{ key: 'orca:last-visited-worktree', value: atBound }])
    expect(await pageAsyncStorage.getItem('orca:last-visited-worktree')).toBe(atBound)
  })

  it('drops a write it may not make rather than rejecting, because nobody catches one', async () => {
    // Ruling 33.4. Every page-closure writer of an unlisted key calls `setItem` with no catch —
    // `notification-delivery-preferences.ts:39` awaits it inside a function its callers `void` —
    // so rejecting here turns a dropped preference into an unhandled rejection in the page. The
    // drop is the old behaviour and the right one; only the journal's oversize path rejects,
    // because the composer is written to catch that one.
    publish()
    await expect(
      pageAsyncStorage.setItem('orca:notificationDeliveryPreferences', '{}')
    ).resolves.toBeUndefined()
    expect(writes).toEqual([])
    expect(await pageAsyncStorage.getItem('orca:notificationDeliveryPreferences')).toBeNull()
  })

  it('drops a removal it may not make, for the same reason', async () => {
    publish()
    await expect(pageAsyncStorage.removeItem('orca:pins:host-2')).resolves.toBeUndefined()
    expect(writes).toEqual([])
  })

  it('drops a write the shell would not take, rather than rejecting', async () => {
    granted = false
    await expect(pageAsyncStorage.setItem('orca:pins:host-1', '["wt-1"]')).resolves.toBeUndefined()
    await expect(pageAsyncStorage.getItem('orca:pins:host-1')).resolves.toBeNull()
  })
})
