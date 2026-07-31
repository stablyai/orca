import { describe, expect, it } from 'vitest'
import { evaluateUpdate, shouldCheckForUpdate, UPDATE_CHECK_INTERVAL_MS } from './app-update-check'

const release = { version: '0.0.37', tag: 'mobile-android-v0.0.37', url: 'https://example.test' }

describe('shouldCheckForUpdate', () => {
  it('only runs on android, where sideloading leaves no update channel', () => {
    expect(shouldCheckForUpdate({ platform: 'ios', state: {}, nowMs: 1000 })).toEqual({
      kind: 'skip',
      reason: 'not-android'
    })
    expect(shouldCheckForUpdate({ platform: 'android', state: {}, nowMs: 1000 })).toEqual({
      kind: 'check'
    })
  })

  it('checks at most once per interval', () => {
    const lastCheckedAtMs = 1_000_000

    expect(
      shouldCheckForUpdate({
        platform: 'android',
        state: { lastCheckedAtMs },
        nowMs: lastCheckedAtMs + UPDATE_CHECK_INTERVAL_MS - 1
      })
    ).toEqual({ kind: 'skip', reason: 'checked-recently' })

    expect(
      shouldCheckForUpdate({
        platform: 'android',
        state: { lastCheckedAtMs },
        nowMs: lastCheckedAtMs + UPDATE_CHECK_INTERVAL_MS
      })
    ).toEqual({ kind: 'check' })
  })

  it('recovers from a clock that moved backwards instead of waiting a day', () => {
    expect(
      shouldCheckForUpdate({
        platform: 'android',
        state: { lastCheckedAtMs: 5_000_000 },
        nowMs: 1_000
      })
    ).toEqual({ kind: 'check' })
  })
})

describe('evaluateUpdate', () => {
  it('prompts only when the release is newer than the running build', () => {
    expect(evaluateUpdate({ currentVersion: '0.0.36', release })).toEqual({
      kind: 'update-available',
      release
    })
    expect(evaluateUpdate({ currentVersion: '0.0.37', release })).toEqual({ kind: 'up-to-date' })
    expect(evaluateUpdate({ currentVersion: '0.0.38', release })).toEqual({ kind: 'up-to-date' })
    expect(evaluateUpdate({ currentVersion: '0.0.36', release: null })).toEqual({
      kind: 'up-to-date'
    })
  })

  it('honors a dismissal for that version but asks again for the next one', () => {
    expect(
      evaluateUpdate({ currentVersion: '0.0.36', release, dismissedVersion: '0.0.37' })
    ).toEqual({ kind: 'dismissed', version: '0.0.37' })

    expect(
      evaluateUpdate({ currentVersion: '0.0.36', release, dismissedVersion: '0.0.36' })
    ).toEqual({ kind: 'update-available', release })
  })
})
