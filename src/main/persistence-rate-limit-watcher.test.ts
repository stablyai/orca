import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_RATE_LIMIT_WATCHER_TABS,
  normalizeRateLimitWatcherTabs
} from '../shared/rate-limit-watcher-types'
import { createStore, testState } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

describe('rate limit watcher armed set', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-rate-limit-watcher-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('arms and disarms one terminal at a time', async () => {
    const store = await createStore()
    expect(store.isRateLimitWatcherEnabled('tab-1')).toBe(false)

    store.setRateLimitWatcherEnabled('tab-1', true)
    store.setRateLimitWatcherEnabled('tab-2', true)
    expect(store.listRateLimitWatcherTabs()).toEqual(['tab-1', 'tab-2'])

    store.setRateLimitWatcherEnabled('tab-1', false)
    expect(store.listRateLimitWatcherTabs()).toEqual(['tab-2'])
    expect(store.isRateLimitWatcherEnabled('tab-1')).toBe(false)
  })

  it('does not duplicate a tab that is already armed', async () => {
    const store = await createStore()
    store.setRateLimitWatcherEnabled('tab-1', true)
    store.setRateLimitWatcherEnabled('tab-1', true)
    expect(store.listRateLimitWatcherTabs()).toEqual(['tab-1'])
  })

  // Closed tab ids never come back, so the list has to be bounded or it only
  // ever grows across the life of the profile.
  it('evicts the oldest ids past the cap', async () => {
    const store = await createStore()
    for (let index = 0; index <= MAX_RATE_LIMIT_WATCHER_TABS; index++) {
      store.setRateLimitWatcherEnabled(`tab-${index}`, true)
    }
    const armed = store.listRateLimitWatcherTabs()
    expect(armed).toHaveLength(MAX_RATE_LIMIT_WATCHER_TABS)
    expect(armed[0]).toBe('tab-1')
    expect(armed.at(-1)).toBe(`tab-${MAX_RATE_LIMIT_WATCHER_TABS}`)
  })

  // The writer only trims the list it is rewriting, so a file edited by hand —
  // or written before the cap existed — has to be brought back in bounds on load.
  describe('load-time normalization', () => {
    it('drops entries that are not usable tab ids', () => {
      expect(normalizeRateLimitWatcherTabs(['tab-1', 42, null, '', 'tab-2', 'tab-1'])).toEqual([
        'tab-1',
        'tab-2'
      ])
    })

    it('falls back to empty for anything that is not an array', () => {
      expect(normalizeRateLimitWatcherTabs(undefined)).toEqual([])
      expect(normalizeRateLimitWatcherTabs('tab-1')).toEqual([])
    })

    it('trims an over-long list to the newest ids', () => {
      const oversized = Array.from(
        { length: MAX_RATE_LIMIT_WATCHER_TABS + 5 },
        (_entry, index) => `tab-${index}`
      )
      const normalized = normalizeRateLimitWatcherTabs(oversized)
      expect(normalized).toHaveLength(MAX_RATE_LIMIT_WATCHER_TABS)
      expect(normalized.at(-1)).toBe(oversized.at(-1))
    })
  })
})
