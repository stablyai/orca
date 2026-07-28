import { describe, expect, it } from 'vitest'
import {
  MAX_SSH_PTY_LIVE_ROSTER_ENTRIES,
  MAX_SSH_PTY_LIVE_ROSTER_ID_BYTES,
  SshPtyLiveRoster
} from './ssh-pty-live-roster'
import { MAX_SSH_APP_PTY_ID_BYTES } from './ssh-pty-wire-admission'

describe('SshPtyLiveRoster', () => {
  it('preserves ordinary listing and exit behavior', () => {
    const roster = new SshPtyLiveRoster()
    const listing = roster.beginListing()

    roster.reconcileListing(listing, ['pty-1'])
    expect(roster.has('pty-1')).toBe(true)

    roster.recordExit('pty-1')
    expect(roster.has('pty-1')).toBe(false)
  })

  it('gives a locally spawned PTY one stale-list grace', () => {
    const roster = new SshPtyLiveRoster()
    roster.recordSpawn('pty-new')

    roster.reconcileListing(roster.beginListing(), [])
    expect(roster.has('pty-new')).toBe(true)

    roster.reconcileListing(roster.beginListing(), [])
    expect(roster.has('pty-new')).toBe(false)
  })

  it('keeps a PTY observed while a listing is in flight', () => {
    const roster = new SshPtyLiveRoster()
    const listing = roster.beginListing()

    roster.recordNotification('pty-new')
    roster.reconcileListing(listing, [])

    expect(roster.has('pty-new')).toBe(true)
  })

  it('ignores an older listing after a newer listing reconciles', () => {
    const roster = new SshPtyLiveRoster()
    roster.recordNotification('pty-live')
    const older = roster.beginListing()
    const newer = roster.beginListing()

    roster.reconcileListing(newer, ['pty-live'])
    roster.reconcileListing(older, [])

    expect(roster.has('pty-live')).toBe(true)
  })

  it('does not resurrect an exit with an in-flight stale listing', () => {
    const roster = new SshPtyLiveRoster()
    roster.recordNotification('pty-exited')
    const listing = roster.beginListing()

    roster.recordExit('pty-exited')
    roster.reconcileListing(listing, ['pty-exited'])

    expect(roster.has('pty-exited')).toBe(false)
  })

  it('caps missed-exit unique-id churn and evicts the oldest live row', () => {
    const roster = new SshPtyLiveRoster()
    const total = MAX_SSH_PTY_LIVE_ROSTER_ENTRIES + 50

    for (let index = 0; index < total; index += 1) {
      roster.recordNotification(`pty-${index}`)
    }

    expect(roster.has('pty-0')).toBe(false)
    expect(roster.has(`pty-${total - MAX_SSH_PTY_LIVE_ROSTER_ENTRIES}`)).toBe(true)
    expect(roster.has(`pty-${total - 1}`)).toBe(true)
  })

  it('does not let exit fences evict supported live entries', () => {
    const roster = new SshPtyLiveRoster()
    for (let index = 0; index < 50; index += 1) {
      roster.recordNotification(`live-${index}`)
    }
    for (let index = 0; index < MAX_SSH_PTY_LIVE_ROSTER_ENTRIES * 2; index += 1) {
      roster.recordExit(`gone-${index}`)
    }

    for (let index = 0; index < 50; index += 1) {
      expect(roster.has(`live-${index}`)).toBe(true)
    }
  })

  it('rejects oversized ids and caps aggregate retained id bytes', () => {
    const roster = new SshPtyLiveRoster()
    const oversized = 'x'.repeat(MAX_SSH_APP_PTY_ID_BYTES + 1)
    roster.recordNotification(oversized)
    expect(roster.has(oversized)).toBe(false)

    const payload = 'x'.repeat(16 * 1024 - 32)
    const total = Math.floor(MAX_SSH_PTY_LIVE_ROSTER_ID_BYTES / Buffer.byteLength(payload)) + 2
    for (let index = 0; index < total; index += 1) {
      roster.recordNotification(`${index}:${payload}`)
    }

    expect(roster.has(`0:${payload}`)).toBe(false)
    expect(roster.has(`${total - 1}:${payload}`)).toBe(true)
  })

  it('ignores a listing response that completes after clear', () => {
    const roster = new SshPtyLiveRoster()
    const listing = roster.beginListing()

    roster.clear()
    roster.reconcileListing(listing, ['pty-stale'])

    expect(roster.has('pty-stale')).toBe(false)
  })

  it('does not resurrect an exit after its tombstone is evicted', () => {
    const roster = new SshPtyLiveRoster()
    roster.recordSpawn('pty-reused')
    const stale = roster.beginListing()
    roster.recordExit('pty-reused')
    for (let index = 0; index < MAX_SSH_PTY_LIVE_ROSTER_ENTRIES; index += 1) {
      roster.recordExit(`gone-${index}`)
    }

    roster.reconcileListing(stale, ['pty-reused'])
    expect(roster.has('pty-reused')).toBe(false)

    const fresh = roster.beginListing()
    roster.reconcileListing(fresh, ['pty-reused'])
    expect(roster.has('pty-reused')).toBe(true)
  })
})
