import { beforeEach, describe, expect, it } from 'vitest'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from '../page-storage-keys'
import pageAsyncStorage, { publishPageStorage } from './page-async-storage'

type Write = { key: string; value: string | null }

const writes: Write[] = []
let granted = true

const HOST_ID = 'host-1'

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
    HOST_ID
  )
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

  it('is refused, and not kept, for a key outside the allowlist', async () => {
    // Held locally it would answer a later read with a value no other screen in the app can see —
    // a pin that looks set and is not, which is the failure the grant exists to avoid.
    await pageAsyncStorage.setItem('orca:mobileWebShellEnabled', 'true')
    expect(writes).toEqual([])
    await expect(pageAsyncStorage.getItem('orca:mobileWebShellEnabled')).resolves.toBeNull()
  })

  it('is refused, and not kept, when the shell granted no storage', async () => {
    granted = false
    await pageAsyncStorage.setItem('orca:pins:host-1', '["wt-1"]')
    await expect(pageAsyncStorage.getItem('orca:pins:host-1')).resolves.toBeNull()
  })

  it('carries each pair of a multi-write separately, and drops the ones outside the list', async () => {
    await pageAsyncStorage.multiSet([
      ['orca:pins:host-1', '["wt-1"]'],
      ['orca:remotePushHostRegistrations', '{}']
    ])
    expect(writes).toEqual([{ key: 'orca:pins:host-1', value: '["wt-1"]' }])
  })

  it('never empties the app store, which is not this document to empty', async () => {
    publish({ 'orca:pins:host-1': '["wt-1"]' })
    await pageAsyncStorage.clear()
    expect(writes).toEqual([])
    await expect(pageAsyncStorage.getItem('orca:pins:host-1')).resolves.toBe('["wt-1"]')
  })
})

describe('what the page will not keep', () => {
  it("refuses another host's pinned list, so a later read cannot answer with it", async () => {
    publish({ 'orca:pins:host-1': '["mine"]' })
    await pageAsyncStorage.setItem('orca:pins:host-2', '["theirs"]')
    // Nothing posted, and nothing cached: a value held here that the shell will not write is a pin
    // that looks set to this document and to nothing else in the app.
    expect(writes).toEqual([])
    expect(await pageAsyncStorage.getItem('orca:pins:host-2')).toBeNull()
  })

  it('refuses a value over the envelope bound rather than caching what the wire will drop', async () => {
    publish()
    const oversized = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1)
    await pageAsyncStorage.setItem('orca:last-visited-worktree', oversized)
    expect(writes).toEqual([])
    expect(await pageAsyncStorage.getItem('orca:last-visited-worktree')).toBeNull()
  })

  it('still keeps a value exactly at the bound, so the refusal above discriminates', async () => {
    publish()
    const atBound = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS)
    await pageAsyncStorage.setItem('orca:last-visited-worktree', atBound)
    expect(writes).toEqual([{ key: 'orca:last-visited-worktree', value: atBound }])
    expect(await pageAsyncStorage.getItem('orca:last-visited-worktree')).toBe(atBound)
  })
})
