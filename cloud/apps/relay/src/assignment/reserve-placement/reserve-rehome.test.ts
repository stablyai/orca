import { describe, expect, it } from 'vitest'
import {
  RESERVE_REHOME_SWITCH_STALE_MS,
  ReserveRehome,
  ReserveRehomeSwitch,
  type RehomeTargetRoom
} from './reserve-rehome.js'

const HOST = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
const ROOM: RehomeTargetRoom = { free: 500, ceiling: 1_000, bookable: true }
// 2,000 controls refill one token a minute.
const CONTROLS = 2_000

function admitted(
  rehome: ReserveRehome,
  overrides: Partial<Parameters<ReserveRehome['admit']>[0]> = {}
) {
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
  it('takes a source cell at 0.05% of its controls a minute, burst one, and refunds an unmade move', () => {
    const rehome = warmed()
    expect(admitted(rehome)).toBeNull()
    expect(admitted(rehome, { identity: { ...HOST, relayHostId: 'qrstuvwxyzabcdef' } })).toBe(
      'source-budget'
    )
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
    const control = new ReserveRehomeSwitch(
      async () => await answer(),
      () => now
    )
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
    const control = new ReserveRehomeSwitch(
      async () => {
        if (reads.length === 0) {
          reads.push('stalled')
          return await new Promise((resolve) => (release = resolve))
        }
        reads.push('off')
        return { enabled: false, notBefore: 0 }
      },
      () => now
    )
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
