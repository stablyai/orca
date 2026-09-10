import { expect, it, vi } from 'vitest'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'
import { legacyMigrationUnsupportedRowsToAliasEntries } from './pane-alias-normalization'

vi.mock('../../agent-hooks/server', () => ({ agentHookServer: {} }))

it('retains only the ambiguity verdict when many legacy rows name the same tab', () => {
  const row: MigrationUnsupportedPtyEntry = {
    ptyId: 'pty',
    tabId: 'tab',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    reason: 'legacy-numeric-pane-key',
    source: 'local',
    updatedAt: 1
  }
  const rows = Array.from({ length: 2000 }, () => row)
  const iterator = Array.prototype[Symbol.iterator]
  let copied = 0
  Array.prototype[Symbol.iterator] = function (this: unknown[]) {
    if (this[0] === row) {
      copied += this.length
    }
    return iterator.call(this)
  }
  let aliases: ReturnType<typeof legacyMigrationUnsupportedRowsToAliasEntries>
  try {
    aliases = legacyMigrationUnsupportedRowsToAliasEntries(rows)
  } finally {
    Array.prototype[Symbol.iterator] = iterator
  }
  expect(copied).toBeLessThan(10_000)
  expect(aliases).toEqual([])
  const unique = legacyMigrationUnsupportedRowsToAliasEntries([row])
  expect(unique.map((entry) => entry.legacyPaneKey)).toEqual(['tab:0', 'tab:1'])
  expect(unique.every((entry) => entry.stablePaneKey === row.paneKey)).toBe(true)
})

function legacyRow(overrides: Partial<MigrationUnsupportedPtyEntry>): MigrationUnsupportedPtyEntry {
  return {
    ptyId: 'pty',
    tabId: 'tab',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    reason: 'legacy-numeric-pane-key',
    source: 'local',
    updatedAt: 1,
    ...overrides
  }
}

// Ambiguity must fail closed: only an exactly-one row per tab may mint an alias.
it.each([
  ['0 rows', 0],
  ['2 rows', 2],
  ['3 rows', 3],
  ['4 rows', 4]
])('mints no alias for a tab named by %s', (_label, count) => {
  const rows = Array.from({ length: count }, (_, i) =>
    legacyRow({
      ptyId: `pty-${i}`,
      paneKey: `tab:1111111${i}-1111-4111-8111-111111111111`
    })
  )
  expect(legacyMigrationUnsupportedRowsToAliasEntries(rows)).toEqual([])
})

it('mints both numeric aliases for a tab named by exactly 1 row', () => {
  const row = legacyRow({ ptyId: 'pty-solo' })
  expect(legacyMigrationUnsupportedRowsToAliasEntries([row])).toEqual([
    {
      ptyId: 'pty-solo',
      legacyPaneKey: 'tab:0',
      stablePaneKey: row.paneKey,
      updatedAt: 1
    },
    {
      ptyId: 'pty-solo',
      legacyPaneKey: 'tab:1',
      stablePaneKey: row.paneKey,
      updatedAt: 1
    }
  ])
})

it('keeps unambiguous tabs in first-seen order while dropping ambiguous neighbours', () => {
  const solo = legacyRow({
    tabId: 'solo',
    ptyId: 'pty-solo',
    paneKey: 'solo:11111111-1111-4111-8111-111111111111'
  })
  const dupA = legacyRow({
    tabId: 'dup',
    ptyId: 'pty-a',
    paneKey: 'dup:22222222-2222-4222-8222-222222222222'
  })
  const dupB = legacyRow({
    tabId: 'dup',
    ptyId: 'pty-b',
    paneKey: 'dup:33333333-3333-4333-8333-333333333333'
  })
  const late = legacyRow({
    tabId: 'late',
    ptyId: 'pty-late',
    paneKey: 'late:44444444-4444-4444-8444-444444444444'
  })
  // A third row for 'dup' must not resurrect it: ambiguity is sticky, not a parity toggle.
  const aliases = legacyMigrationUnsupportedRowsToAliasEntries([solo, dupA, dupB, late, dupA])
  expect(aliases.map((entry) => entry.legacyPaneKey)).toEqual([
    'solo:0',
    'solo:1',
    'late:0',
    'late:1'
  ])
  expect(aliases.every((entry) => entry.ptyId !== 'pty-a' && entry.ptyId !== 'pty-b')).toBe(true)
})
