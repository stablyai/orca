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
    // Read synchronously from the cache behind the async API; a round trip would change first-render/golden timing.
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
    // Drop unlisted writes without caching an app-invisible value; preference callers have no catch for a rejection (ruling 33.4).
    await expect(pageAsyncStorage.setItem('orca:hosts', 'true')).resolves.toBeUndefined()
    expect(writes).toEqual([])
    await expect(pageAsyncStorage.getItem('orca:hosts')).resolves.toBeNull()
  })

  it('carries each pair of a multi-write up to the first it cannot, and no further', async () => {
    await expect(
      pageAsyncStorage.multiSet([
        ['orca:pins:host-1', '["wt-1"]'],
        ['orca:remotePushHostRegistrations', '{}']
      ])
    ).resolves.toBeUndefined()
    // Stop at the first refusal after applying preceding pairs; one batch gets one answer (ruling 35).
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
    // Neither post nor cache a write the shell refuses; otherwise only this page would believe the pin persisted.
    expect(writes).toEqual([])
    expect(await pageAsyncStorage.getItem('orca:pins:host-2')).toBeNull()
  })

  it("drops another workspace's chat tabs on the session route it was not opened for", async () => {
    publish()
    await expect(
      pageAsyncStorage.setItem('orca:nativeChatTabs:host-1:wt-2', '{}')
    ).resolves.toBeUndefined()
    expect(writes).toEqual([])
    await pageAsyncStorage.setItem('orca:nativeChatTabs:host-1:wt-1', '{}')
    expect(writes).toEqual([{ key: 'orca:nativeChatTabs:host-1:wt-1', value: '{}' }])
  })

  it('refuses a value over the envelope bound rather than caching what the wire will drop', async () => {
    publish()
    const oversized = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1)
    const refusal = await refusalOf(
      pageAsyncStorage.setItem('orca:mobileStructuredSendOperations:v1', oversized)
    )
    // The durable journal exceeds this bound at 48 unsettled sends; report not-sent rather than lose the operation id (ruling 7).
    expect(refusal.refusal).toBe('too-large')
    expect(refusal.message).toContain('orca:mobileStructuredSendOperations:v1')
    expect(refusal.message).toContain(String(PAGE_STORAGE_MAX_VALUE_CHARS))
    expect(writes).toEqual([])
    expect(await pageAsyncStorage.getItem('orca:mobileStructuredSendOperations:v1')).toBeNull()
  })

  // Stop on the first oversized pair; constructing rejected promises for later failures would leave them unhandled.
  it('rejects a batch of two oversize pairs once, leaving no rejection nobody holds', async () => {
    publish()
    const unhandled: unknown[] = []
    const record = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      const oversized = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1)
      const refusal = await refusalOf(
        pageAsyncStorage.multiSet([
          ['orca:mobileStructuredSendOperations:v1', oversized],
          ['orca:custom-accessory-keys', oversized]
        ])
      )
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
      expect(refusal.key).toBe('orca:mobileStructuredSendOperations:v1')
      expect(writes).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  it('still keeps a value exactly at the bound, so the refusal above discriminates', async () => {
    publish()
    const atBound = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS)
    await pageAsyncStorage.setItem('orca:last-visited-worktree', atBound)
    expect(writes).toEqual([{ key: 'orca:last-visited-worktree', value: atBound }])
    expect(await pageAsyncStorage.getItem('orca:last-visited-worktree')).toBe(atBound)
  })

  it('drops a write it may not make rather than rejecting, because nobody catches one', async () => {
    // Unlisted-key preference writers await setItem without catches, often under void callers; retain silent drop. Only oversize journal writes reject because the composer catches them (ruling 33.4).
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
