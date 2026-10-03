import { describe, expect, it } from 'vitest'
import { canHandoffDaemonHistory, shouldHandoffDaemonHistory } from './daemon-history-handoff'
import { HISTORY_SEED_TRANSFER_PROTOCOL_VERSION, PROTOCOL_VERSION } from './daemon-protocol-version'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

function fakeAdapter(protocolVersion: number): DaemonPtyAdapter {
  return { protocolVersion } as DaemonPtyAdapter
}

describe('canHandoffDaemonHistory', () => {
  it('is true crossing the seed-transfer floor: owner below it, current at or above it', () => {
    const owner = fakeAdapter(HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    const current = fakeAdapter(PROTOCOL_VERSION)
    expect(canHandoffDaemonHistory(owner, current)).toBe(true)
  })

  it('is false when owner is already at or above the seed-transfer floor', () => {
    const owner = fakeAdapter(HISTORY_SEED_TRANSFER_PROTOCOL_VERSION)
    const current = fakeAdapter(PROTOCOL_VERSION)
    expect(canHandoffDaemonHistory(owner, current)).toBe(false)
  })

  it('is false when current itself is below the seed-transfer floor', () => {
    const owner = fakeAdapter(HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 2)
    const current = fakeAdapter(HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    expect(canHandoffDaemonHistory(owner, current)).toBe(false)
  })

  it('is false when owner and current are the same adapter instance', () => {
    const same = fakeAdapter(PROTOCOL_VERSION)
    expect(canHandoffDaemonHistory(same, same)).toBe(false)
  })
})

describe('shouldHandoffDaemonHistory (unchanged external contract)', () => {
  it('requires an explicit keepHistory request even when the version gate passes', () => {
    const owner = fakeAdapter(HISTORY_SEED_TRANSFER_PROTOCOL_VERSION - 1)
    const current = fakeAdapter(PROTOCOL_VERSION)
    expect(shouldHandoffDaemonHistory(false, owner, current)).toBe(false)
    expect(shouldHandoffDaemonHistory(undefined, owner, current)).toBe(false)
    expect(shouldHandoffDaemonHistory(true, owner, current)).toBe(true)
  })

  it('stays false when keepHistory is true but the version gate fails', () => {
    const owner = fakeAdapter(HISTORY_SEED_TRANSFER_PROTOCOL_VERSION)
    const current = fakeAdapter(PROTOCOL_VERSION)
    expect(shouldHandoffDaemonHistory(true, owner, current)).toBe(false)
  })
})
