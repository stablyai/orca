import { expect, it } from 'vitest'
import { createDrainMigrationRowLookup } from './drain-migration-row-lookup.js'
import type { SqlRow } from './database.js'

function text(row: SqlRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') {
    throw new Error(`invalid_${field}`)
  }
  return value
}

it('keeps first assignment matches, lease order, row identity, and separate identity components', () => {
  const rows = [
    { user_id: 'a:b', relay_host_id: 'c', value: 1 },
    { user_id: 'a', relay_host_id: 'b:c', value: 2 },
    { user_id: 'a:b', relay_host_id: 'c', value: 3 },
    { user_id: '', relay_host_id: '', value: 4 }
  ]
  const lookup = createDrainMigrationRowLookup(rows, text)
  for (const identity of [
    { userId: 'a:b', relayHostId: 'c' },
    { userId: 'a', relayHostId: 'b:c' },
    { userId: '', relayHostId: '' },
    { userId: 'missing', relayHostId: 'c' }
  ]) {
    const expected = rows.filter(
      (row) =>
        row.user_id === identity.userId && row.relay_host_id === identity.relayHostId
    )
    expect(lookup.first(identity)).toBe(expected[0])
    expect(lookup.all(identity)).toEqual(expected)
    lookup.all(identity).forEach((row, index) => expect(row).toBe(expected[index]))
  }
})

it('retains lazy validation and short circuiting when an inventory is malformed', () => {
  const first = { user_id: 'user', relay_host_id: 'host' }
  const identity = { userId: 'user', relayHostId: 'host' }
  const lookup = createDrainMigrationRowLookup(
    [first, { user_id: null, relay_host_id: 'bad' }],
    text
  )
  expect(lookup.first(identity)).toBe(first)
  expect(() => lookup.all(identity)).toThrow('invalid_user_id')
  const unrelated = createDrainMigrationRowLookup(
    [first, { user_id: 'other', relay_host_id: null }],
    text
  )
  expect(unrelated.all(identity)).toEqual([first])
  expect(() => unrelated.first({ userId: 'other', relayHostId: 'host' })).toThrow(
    'invalid_relay_host_id'
  )
})

it('does not share an index between refreshed inventories', () => {
  const identity = { userId: 'user', relayHostId: 'host' }
  const oldRow = { user_id: 'user', relay_host_id: 'host', version: 1 }
  const newRow = { ...oldRow, version: 2 }
  expect(createDrainMigrationRowLookup([oldRow], text).first(identity)).toBe(oldRow)
  expect(createDrainMigrationRowLookup([newRow], text).first(identity)).toBe(newRow)
})
