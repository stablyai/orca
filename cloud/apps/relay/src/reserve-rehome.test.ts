import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openInMemoryRelayDatabase } from './database.js'
import { hostCohortBucket } from './host-cohort-bucket.js'
import {
  RESERVE_REHOME_HOST_COOLDOWN_MS,
  RESERVE_REHOME_SWITCH_STALE_MS,
  ReserveRehome,
  ReserveRehomeSwitch,
  type RehomeTargetRoom
} from './reserve-rehome.js'

const HOST = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
const ROOM: RehomeTargetRoom = { free: 500, ceiling: 1_000, bookable: true }
// 2,000 controls refill one token a minute.
const CONTROLS = 2_000

function admitted(rehome: ReserveRehome, overrides: Partial<Parameters<ReserveRehome['admit']>[0]> = {}) {
  return rehome.admit({
    identity: HOST,
    sourceCellId: 'us-r',
    sourceControls: CONTROLS,
    leaves: [],
    target: ROOM,
    now: 60_000,
    ...overrides
  })
}

// A rehome whose source bucket for us-r started at 0 and is full by 60 s.
function warmed(percent = 100) {
  const rehome = new ReserveRehome({ percent, switchOpen: () => true })
  expect(admitted(rehome, { now: 0, target: { ...ROOM, bookable: false } })).toBe('target-room')
  expect(admitted(rehome, { now: 0 })).toBe('source-budget')
  return rehome
}

describe('rehome on reconnect rules', () => {
  it('is off at 0%, and admits a host whose every rule holds', () => {
    expect(new ReserveRehome({ percent: 0, switchOpen: () => true }).enabled).toBe(false)
    expect(admitted(warmed())).toBeNull()
  })

  it('stays off while the operator switch is closed', () => {
    expect(admitted(new ReserveRehome({ percent: 100, switchOpen: () => false }))).toBe('switch')
  })

  it('moves only the cohort below the percent', () => {
    const bucket = hostCohortBucket(HOST)
    expect(admitted(new ReserveRehome({ percent: bucket, switchOpen: () => true }))).toBe('cohort')
    expect(admitted(warmed(bucket + 1))).toBeNull()
  })

  it('leaves a host that another install dropped in the last 10 minutes', () => {
    const peerDropped = { region: 'us-central1' as const, closeCode: RELAY_CLOSE_CODE.PEER_DROPPED }
    expect(admitted(warmed(), { leaves: [{ ...peerDropped, at: 60_000 - 10 * 60_000 }] })).toBe('peer-dropped')
    expect(admitted(warmed(), { leaves: [{ ...peerDropped, at: 60_000 - 10 * 60_000 - 1 }] })).toBeNull()
  })

  it('leaves a host whose remembered leaves span regions, or that it moved within a day', () => {
    const leaves = [
      { region: 'us-central1' as const, at: 1 },
      { region: 'asia-east2' as const, at: 2 }
    ]
    expect(admitted(warmed(), { leaves })).toBe('moved-recently')
    expect(admitted(warmed(), { leaves: [{ region: undefined, at: 1 }] })).toBe('unknown-leave-region')
    const rehome = warmed()
    rehome.recordMoved(HOST, 0)
    expect(admitted(rehome)).toBe('moved-recently')
    expect(admitted(rehome, { now: RESERVE_REHOME_HOST_COOLDOWN_MS })).toBeNull()
  })

  it('moves no one into a region under 10% free, however full the source is', () => {
    expect(admitted(warmed(), { target: { free: 20, ceiling: 1_000, bookable: true } })).toBe('target-room')
    expect(admitted(warmed(), { target: { free: 99, ceiling: 1_000, bookable: true } })).toBe('target-room')
    expect(admitted(warmed(), { target: { free: 100, ceiling: 1_000, bookable: true } })).toBeNull()
    expect(admitted(warmed(), { target: { free: 500, ceiling: 1_000, bookable: false } })).toBe('target-room')
    expect(admitted(warmed(), { target: { free: 0, ceiling: 0, bookable: false } })).toBe('target-room')
  })

  it('takes a source cell at 0.05% of its controls a minute, burst one, and refunds an unmade move', () => {
    const rehome = warmed()
    expect(admitted(rehome)).toBeNull()
    expect(admitted(rehome, { identity: { ...HOST, relayHostId: 'qrstuvwxyzabcdef' } })).toBe('source-budget')
    expect(admitted(rehome, { sourceCellId: 'us-r2', now: 0 })).toBe('source-budget')
    rehome.refund('us-r')
    expect(admitted(rehome, { identity: { ...HOST, relayHostId: 'qrstuvwxyzabcdef' } })).toBeNull()
    // Half a minute refills half a token; a long idle still holds only one.
    expect(admitted(rehome, { now: 90_000 })).toBe('source-budget')
    expect(admitted(rehome, { now: 10 * 60_000 })).toBeNull()
    expect(admitted(rehome, { now: 10 * 60_000 })).toBe('source-budget')
  })
})

describe('rehome switch', () => {
  it('reads unknown, failed and stale as off', async () => {
    let now = 1_000
    let answer: () => Promise<{ enabled: boolean; notBefore: number } | null> = async () => ({
      enabled: true,
      notBefore: 0
    })
    const control = new ReserveRehomeSwitch(async () => await answer(), () => now)
    expect(control.isOpen(now)).toBe(false)
    await control.refresh()
    expect(control.isOpen(now)).toBe(true)
    expect(control.isOpen(now + RESERVE_REHOME_SWITCH_STALE_MS + 1)).toBe(false)
    answer = async () => {
      throw new Error('timeout')
    }
    await control.refresh()
    expect(control.isOpen(now)).toBe(false)
    answer = async () => null
    await control.refresh()
    expect(control.isOpen(now)).toBe(false)
    answer = async () => ({ enabled: false, notBefore: 0 })
    await control.refresh()
    expect(control.isOpen(now)).toBe(false)
    answer = async () => ({ enabled: true, notBefore: 5_000 })
    await control.refresh()
    expect(control.isOpen(now)).toBe(false)
    now = 5_000
    expect(control.isOpen(now)).toBe(true)
  })
})

describe('the rehome switch under a stalled read', () => {
  it('never lets a slow answer land after a newer one, and ages it from its question', async () => {
    let now = 1_000
    let release!: (value: { enabled: boolean; notBefore: number }) => void
    const reads: ('stalled' | 'off')[] = []
    const control = new ReserveRehomeSwitch(async () => {
      if (reads.length === 0) {
        reads.push('stalled')
        return await new Promise((resolve) => (release = resolve))
      }
      reads.push('off')
      return { enabled: false, notBefore: 0 }
    }, () => now)
    const stalled = control.refresh()
    await control.refresh()
    expect(reads).toEqual(['stalled'])
    now += RESERVE_REHOME_SWITCH_STALE_MS
    release({ enabled: true, notBefore: 0 })
    await stalled
    // Asked at 1 s, answered past the stale bound: off.
    expect(control.isOpen(now + 1)).toBe(false)
  })
})

describe('the rehome switch read', () => {
  it('reads the operator row, and nothing before it exists', async () => {
    const database = await openInMemoryRelayDatabase()
    try {
      let now = 100_000_000
      const store = new RelayAssignmentStore(database, () => now)
      expect(await store.regionRehomeSwitch()).toBeNull()
      await store.inspectRegionalRehomeControl()
      expect(await store.regionRehomeSwitch()).toMatchObject({ enabled: false })
      now += 86_400_000
      await store.applyRegionalRehomeControl({
        expectedGeneration: 0,
        enabled: true,
        notBefore: now + 1_000,
        ratePerMinute: 10,
        preferenceMaxAgeMs: 86_400_000,
        hostCooldownMs: 604_800_000,
        drainGraceMs: 60_000
      })
      expect(await store.regionRehomeSwitch()).toEqual({ enabled: true, notBefore: now + 1_000 })
    } finally {
      await database.close()
    }
  })
})
