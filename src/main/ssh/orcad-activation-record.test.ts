import { describe, expect, it } from 'vitest'

import {
  emptyOrcadActivationRecord,
  orcadGcPinnedDirNames,
  parseOrcadActivationRecord,
  serializeOrcadActivationRecord,
  withActivatedVersion,
  withRolledBackVersion,
  type OrcadStateSnapshot
} from './orcad-activation-record'
import { sameOrcadActivationRecord } from './orcad-activation-transaction'

const SNAPSHOT: OrcadStateSnapshot = {
  dirName: 'pre-0.2.0+bb01-1000',
  takenBeforeVersion: '0.2.0+bb01',
  readableByVersion: '0.1.0+aa01',
  takenAt: '2026-01-01T00:00:00.000Z'
}
const NOW = new Date('2026-01-02T00:00:00.000Z')

describe('orcad activation record', () => {
  it('round-trips through the host', () => {
    const record = withActivatedVersion(
      { ...emptyOrcadActivationRecord(), active: '0.1.0+aa01' },
      '0.2.0+bb01',
      SNAPSHOT,
      NOW
    )
    const parsed = parseOrcadActivationRecord(serializeOrcadActivationRecord(record))
    expect(parsed).toEqual({ state: 'ok', record })
  })

  it('reports an absent record as absent', () => {
    expect(parseOrcadActivationRecord(null)).toEqual({ state: 'absent' })
    expect(parseOrcadActivationRecord('   ')).toEqual({ state: 'absent' })
  })

  it('reports a newer schema as unreadable, never as absent', () => {
    const parsed = parseOrcadActivationRecord(JSON.stringify({ schemaVersion: 2, active: 'x' }))
    expect(parsed.state).toBe('unreadable')
  })

  it('reports corrupt JSON as unreadable, never as absent', () => {
    expect(parseOrcadActivationRecord('{not json').state).toBe('unreadable')
  })

  it('names the outgoing version as the rollback target', () => {
    const record = withActivatedVersion(
      { ...emptyOrcadActivationRecord(), active: '0.1.0+aa01' },
      '0.2.0+bb01',
      SNAPSHOT,
      NOW
    )
    expect(record).toMatchObject({ active: '0.2.0+bb01', previous: '0.1.0+aa01' })
  })

  it('does not let a re-deploy of the active version erase the rollback target', () => {
    const before = {
      ...emptyOrcadActivationRecord(),
      active: '0.2.0+bb01',
      previous: '0.1.0+aa01',
      snapshot: SNAPSHOT
    }
    const after = withActivatedVersion(before, '0.2.0+bb01', null, NOW)
    expect(after).toMatchObject({ active: '0.2.0+bb01', previous: '0.1.0+aa01' })
    expect(after.snapshot).toEqual(SNAPSHOT)
  })

  it('clears the rollback target after rolling back, so it cannot walk into the bad build', () => {
    const before = {
      ...emptyOrcadActivationRecord(),
      active: '0.2.0+bb01',
      previous: '0.1.0+aa01',
      snapshot: SNAPSHOT
    }
    expect(withRolledBackVersion(before, NOW)).toMatchObject({
      active: '0.1.0+aa01',
      previous: null,
      snapshot: null
    })
  })

  it('pins the active version, the rollback target and the live daemon"s bundle against GC', () => {
    const pinned = orcadGcPinnedDirNames(
      {
        ...emptyOrcadActivationRecord(),
        active: '0.3.0+cc01',
        previous: '0.2.0+bb01'
      },
      '0.1.0+aa01'
    )
    expect(pinned).toEqual(['orcad-0.3.0+cc01', 'orcad-0.2.0+bb01', 'orcad-0.1.0+aa01'])
  })

  // Design D7.1 R4; the real two-slot swap is orcad-cross-runtime-daemon-adoption.integration.test.ts.
  it('pins a Bun-era slot whose live daemon a Node orcad adopted, rollback target or not', () => {
    const bunSlotVersion = '0.1.0+ea9eae1d1d6a'
    const nodeRecord = { ...emptyOrcadActivationRecord(), active: '0.1.0+a97ad77bf77c' }
    expect(orcadGcPinnedDirNames(nodeRecord, bunSlotVersion)).toContain(`orcad-${bunSlotVersion}`)
    expect(orcadGcPinnedDirNames(nodeRecord)).not.toContain(`orcad-${bunSlotVersion}`)
  })

  it('deduplicates pins when the live daemon came from the active bundle', () => {
    const pinned = orcadGcPinnedDirNames(
      { ...emptyOrcadActivationRecord(), active: '0.3.0+cc01', previous: null },
      '0.3.0+cc01'
    )
    expect(pinned).toEqual(['orcad-0.3.0+cc01'])
  })

  it('records which Orca activated each version, and the build a rollback left', () => {
    const first = withActivatedVersion(
      emptyOrcadActivationRecord(),
      '0.1.0+aa01',
      null,
      NOW,
      '1.4.0'
    )
    const second = withActivatedVersion(first, '0.2.0+bb01', SNAPSHOT, NOW, '1.5.0')
    expect(second).toMatchObject({ activeAppVersion: '1.5.0', previousAppVersion: '1.4.0' })
    expect(parseOrcadActivationRecord(serializeOrcadActivationRecord(second))).toEqual({
      state: 'ok',
      record: second
    })
    const rolledBack = withRolledBackVersion(second, NOW)
    expect(rolledBack).toMatchObject({
      active: '0.1.0+aa01',
      activeAppVersion: '1.4.0',
      rolledBackFrom: '0.2.0+bb01'
    })
    // A later activation is an explicit choice, so it lifts the hold.
    expect(withActivatedVersion(rolledBack, '0.3.0+cc01', null, NOW, '1.6.0')).not.toHaveProperty(
      'rolledBackFrom'
    )
  })

  it('matches a journal from a build that drops the advisory fields', () => {
    const current = withActivatedVersion(
      emptyOrcadActivationRecord(),
      '0.1.0+aa01',
      null,
      NOW,
      '1.5.0'
    )
    const { activeAppVersion: _dropped, ...older } = current
    expect(sameOrcadActivationRecord(current, older)).toBe(true)
    expect(sameOrcadActivationRecord(current, { ...older, active: '0.2.0+bb01' })).toBe(false)
  })
})
