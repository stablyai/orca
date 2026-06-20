import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UPDATE_COOLDOWN_DAYS,
  eligibleAtMs,
  isVersionEligible,
  pruneFirstSeenLedger,
  recordVersionFirstSeen,
  resolveUpdateCooldownMs
} from './updater-cooldown'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

describe('resolveUpdateCooldownMs', () => {
  it('defaults to zero (cooldown disabled) when nothing is configured', () => {
    expect(DEFAULT_UPDATE_COOLDOWN_DAYS).toBe(0)
    expect(resolveUpdateCooldownMs({})).toBe(0)
    expect(resolveUpdateCooldownMs({ settingDays: null })).toBe(0)
  })

  it('uses the persisted setting when present', () => {
    expect(resolveUpdateCooldownMs({ settingDays: 3 })).toBe(3 * DAY)
  })

  it('lets the env var override the setting', () => {
    expect(resolveUpdateCooldownMs({ envValue: '7', settingDays: 3 })).toBe(7 * DAY)
  })

  it('ignores blank, non-numeric, or negative env values', () => {
    expect(resolveUpdateCooldownMs({ envValue: '', settingDays: 2 })).toBe(2 * DAY)
    expect(resolveUpdateCooldownMs({ envValue: '   ', settingDays: 2 })).toBe(2 * DAY)
    expect(resolveUpdateCooldownMs({ envValue: 'abc', settingDays: 2 })).toBe(2 * DAY)
    expect(resolveUpdateCooldownMs({ envValue: '-5', settingDays: 2 })).toBe(2 * DAY)
  })

  it('supports fractional days', () => {
    expect(resolveUpdateCooldownMs({ envValue: '0.5' })).toBe(0.5 * DAY)
  })

  it('ignores a negative or non-finite setting', () => {
    expect(resolveUpdateCooldownMs({ settingDays: -1 })).toBe(0)
    expect(resolveUpdateCooldownMs({ settingDays: Number.NaN })).toBe(0)
  })
})

describe('recordVersionFirstSeen', () => {
  it('stamps a newly observed version with now', () => {
    const next = recordVersionFirstSeen({}, '1.4.62', NOW)
    expect(next).toEqual({ '1.4.62': NOW })
  })

  it('does not overwrite an existing earlier timestamp', () => {
    const ledger = { '1.4.62': NOW - DAY }
    const next = recordVersionFirstSeen(ledger, '1.4.62', NOW)
    expect(next).toBe(ledger)
  })

  it('clamps a future timestamp (clock moved backward) down to now', () => {
    const ledger = { '1.4.62': NOW + DAY }
    const next = recordVersionFirstSeen(ledger, '1.4.62', NOW)
    expect(next).toEqual({ '1.4.62': NOW })
  })

  it('keeps other versions intact when adding one', () => {
    const next = recordVersionFirstSeen({ '1.4.61': NOW - DAY }, '1.4.62', NOW)
    expect(next).toEqual({ '1.4.61': NOW - DAY, '1.4.62': NOW })
  })
})

describe('isVersionEligible', () => {
  it('is always eligible when cooldown is disabled', () => {
    expect(isVersionEligible({ ledger: {}, version: '1.4.62', nowMs: NOW, cooldownMs: 0 })).toBe(
      true
    )
  })

  it('is not eligible for a version never recorded', () => {
    expect(isVersionEligible({ ledger: {}, version: '1.4.62', nowMs: NOW, cooldownMs: DAY })).toBe(
      false
    )
  })

  it('is not eligible until the cooldown has elapsed', () => {
    const ledger = { '1.4.62': NOW - (DAY - 1) }
    expect(isVersionEligible({ ledger, version: '1.4.62', nowMs: NOW, cooldownMs: DAY })).toBe(
      false
    )
  })

  it('is eligible exactly at the cooldown boundary', () => {
    const ledger = { '1.4.62': NOW - DAY }
    expect(isVersionEligible({ ledger, version: '1.4.62', nowMs: NOW, cooldownMs: DAY })).toBe(true)
  })

  it('is eligible once the cooldown has passed', () => {
    const ledger = { '1.4.62': NOW - 3 * DAY }
    expect(isVersionEligible({ ledger, version: '1.4.62', nowMs: NOW, cooldownMs: DAY })).toBe(true)
  })

  it('treats a future timestamp as now, so a rewound clock cannot shorten the wait', () => {
    const ledger = { '1.4.62': NOW + 10 * DAY }
    expect(isVersionEligible({ ledger, version: '1.4.62', nowMs: NOW, cooldownMs: DAY })).toBe(
      false
    )
  })
})

describe('eligibleAtMs', () => {
  it('is null when cooldown is disabled', () => {
    expect(eligibleAtMs({ ledger: {}, version: '1.4.62', nowMs: NOW, cooldownMs: 0 })).toBeNull()
  })

  it('is null for an unrecorded version', () => {
    expect(eligibleAtMs({ ledger: {}, version: '1.4.62', nowMs: NOW, cooldownMs: DAY })).toBeNull()
  })

  it('returns firstSeen + cooldown', () => {
    const ledger = { '1.4.62': NOW - DAY }
    expect(eligibleAtMs({ ledger, version: '1.4.62', nowMs: NOW, cooldownMs: 3 * DAY })).toBe(
      NOW - DAY + 3 * DAY
    )
  })

  it('clamps a future firstSeen to now before adding the cooldown', () => {
    const ledger = { '1.4.62': NOW + DAY }
    expect(eligibleAtMs({ ledger, version: '1.4.62', nowMs: NOW, cooldownMs: DAY })).toBe(NOW + DAY)
  })
})

describe('pruneFirstSeenLedger', () => {
  it('drops versions at or below the installed version', () => {
    const ledger = { '1.4.60': NOW, '1.4.61': NOW, '1.4.62': NOW }
    expect(pruneFirstSeenLedger(ledger, '1.4.61')).toEqual({ '1.4.62': NOW })
  })

  it('keeps all versions newer than the installed version', () => {
    const ledger = { '1.4.62': NOW, '1.5.0': NOW }
    expect(pruneFirstSeenLedger(ledger, '1.4.61')).toEqual(ledger)
  })

  it('returns an empty ledger when nothing is newer', () => {
    expect(pruneFirstSeenLedger({ '1.0.0': NOW }, '2.0.0')).toEqual({})
  })
})
