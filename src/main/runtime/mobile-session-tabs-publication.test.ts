import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSessionTabsPublicationClock } from './mobile-session-tabs-publication'

const WORKTREE = 'repo::/worktree'

describe('MobileSessionTabsPublicationClock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps one epoch across mutations and strictly increases the version', () => {
    const clock = new MobileSessionTabsPublicationClock()
    const first = clock.next(WORKTREE)
    const second = clock.next(WORKTREE, first)
    const third = clock.next(WORKTREE, second)
    expect(first.publicationEpoch.startsWith('headless:')).toBe(true)
    expect(second.publicationEpoch).toBe(first.publicationEpoch)
    expect(third.publicationEpoch).toBe(first.publicationEpoch)
    expect(second.snapshotVersion).toBeGreaterThan(first.snapshotVersion)
    expect(third.snapshotVersion).toBeGreaterThan(second.snapshotVersion)
  })

  it('reuses the stored snapshot epoch over minting, whatever its source', () => {
    const clock = new MobileSessionTabsPublicationClock()
    const stamp = clock.next(WORKTREE, {
      publicationEpoch: 'renderer:abc',
      snapshotVersion: 7
    })
    expect(stamp.publicationEpoch).toBe('renderer:abc')
    expect(stamp.snapshotVersion).toBe(8)
  })

  it('survives snapshot-map deletion: boot epoch is reused and the floor holds', () => {
    const clock = new MobileSessionTabsPublicationClock()
    const first = clock.next(WORKTREE)
    const second = clock.next(WORKTREE, first)
    // Entry deleted: no `existing` — the boot epoch and version floor persist.
    const revived = clock.next(WORKTREE)
    expect(revived.publicationEpoch).toBe(first.publicationEpoch)
    expect(revived.snapshotVersion).toBeGreaterThan(second.snapshotVersion)
  })

  it('applies the mint prefix only to the boot-first mint', () => {
    const clock = new MobileSessionTabsPublicationClock()
    const hydrated = clock.next(WORKTREE, undefined, { mintPrefix: 'headless-hydrated' })
    expect(hydrated.publicationEpoch.startsWith('headless-hydrated:')).toBe(true)
    const later = clock.next(WORKTREE, undefined, { mintPrefix: 'headless:pty-backed' })
    expect(later.publicationEpoch).toBe(hydrated.publicationEpoch)
  })

  it('keeps versions strictly increasing across interleaved publish sources', () => {
    const clock = new MobileSessionTabsPublicationClock()
    const versions: number[] = []
    versions.push(clock.next(WORKTREE).snapshotVersion) // mutation on empty
    versions.push(clock.nextVersion(WORKTREE, versions.at(-1))) // hydrate rebuild
    clock.observe(WORKTREE, 50) // renderer-accepted stored version
    versions.push(clock.nextVersion(WORKTREE, 2)) // touch over a stale entry
    versions.push(
      clock.next(WORKTREE, { publicationEpoch: 'e', snapshotVersion: 10 }).snapshotVersion
    )
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]!).toBeGreaterThan(versions[i - 1]!)
    }
    expect(versions.at(-1)!).toBeGreaterThan(50)
  })

  it('observe never lowers the floor', () => {
    const clock = new MobileSessionTabsPublicationClock()
    clock.observe(WORKTREE, 20)
    clock.observe(WORKTREE, 5)
    expect(clock.nextVersion(WORKTREE)).toBe(21)
  })

  it('scopes version floors per worktree', () => {
    const clock = new MobileSessionTabsPublicationClock()
    clock.next('repo::/a')
    clock.observe('repo::/a', 40)
    // Worktree b's floor is untouched by a's publications.
    expect(clock.next('repo::/b').snapshotVersion).toBe(1)
    expect(clock.nextVersion('repo::/a')).toBe(41)
  })

  it('mints a fresh epoch per boot', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const boot1 = new MobileSessionTabsPublicationClock().next(WORKTREE)
    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'))
    const boot2 = new MobileSessionTabsPublicationClock().next(WORKTREE)
    expect(boot2.publicationEpoch).not.toBe(boot1.publicationEpoch)
    // A rebooted host starts a new same-epoch ordering domain from version 1.
    expect(boot2.snapshotVersion).toBe(1)
  })
})
