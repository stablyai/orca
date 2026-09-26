import { describe, expect, it } from 'vitest'
import {
  formatAssignmentInventorySnapshot,
  type AssignmentInventorySnapshot
} from './assignment-inventory-snapshot.js'

// The enable workflow reads the director's rehome inventory line out of Cloud
// Logging with a parser that lives in another language, in another package, and
// is never exercised against the formatter that writes the line. When
// `hostNotArrivedLast24Hours` shipped, the parser read a healthy line as no
// evidence at all and the run failed closed, disabling the durable switch. This
// test is the missing edge: the real formatter's output, through the real
// parser, so a future field fails here instead of in an operator's run.

type InventoryEvidence = {
  active: number
  awaitingReceipt: number
  targetRegistered: number
  completedLast24Hours: number
  abortedLast24Hours: number
  hostNotArrivedLast24Hours: number | null
  oldestActiveAgeMs: number | null
}

// Imported through a computed URL on purpose: the script is plain ESM outside
// this package's compile scope, so a static import would not resolve.
async function loadParser(): Promise<(entries: unknown[], options: unknown) => InventoryEvidence> {
  const source = new URL(
    '../../../dev/scripts/relay-rehome-aggregate-evidence.mjs',
    import.meta.url
  ).href
  const loaded: unknown = await import(/* @vite-ignore */ source)
  if (!(loaded !== null && typeof loaded === 'object' && 'parseRegionalRehomeInventory' in loaded)) {
    throw new Error('relay-rehome-aggregate-evidence.mjs no longer exports its parser')
  }
  const parse = loaded.parseRegionalRehomeInventory
  if (typeof parse !== 'function') throw new Error('parseRegionalRehomeInventory is not callable')
  return (entries, options) => readEvidence(parse(entries, options))
}

function readEvidence(value: unknown): InventoryEvidence {
  if (value === null || typeof value !== 'object') throw new Error('parser returned no evidence')
  const counts = ['active', 'awaitingReceipt', 'targetRegistered', 'completedLast24Hours', 'abortedLast24Hours'] as const
  const evidence: Record<string, number | null> = {}
  for (const key of [...counts, 'hostNotArrivedLast24Hours', 'oldestActiveAgeMs'] as const) {
    if (!(key in value)) throw new Error(`parser dropped ${key}`)
    const read: unknown = Reflect.get(value, key)
    if (read !== null && typeof read !== 'number') throw new Error(`${key} is not a count`)
    evidence[key] = read
  }
  for (const key of counts) {
    if (evidence[key] === null) throw new Error(`${key} must be a number`)
  }
  return {
    active: Number(evidence['active']),
    awaitingReceipt: Number(evidence['awaitingReceipt']),
    targetRegistered: Number(evidence['targetRegistered']),
    completedLast24Hours: Number(evidence['completedLast24Hours']),
    abortedLast24Hours: Number(evidence['abortedLast24Hours']),
    hostNotArrivedLast24Hours: evidence['hostNotArrivedLast24Hours'] ?? null,
    oldestActiveAgeMs: evidence['oldestActiveAgeMs'] ?? null
  }
}

function snapshot(
  regionalRehomes: AssignmentInventorySnapshot['regionalRehomes']
): AssignmentInventorySnapshot {
  return {
    cells: [],
    activityLeases: { total: 0, expired: 0, requestUnits: 0 },
    connectionReservations: { outstanding: 0, lateArrivalDebt: 0 },
    regionalRehomes
  }
}

function inventoryLine(snapshotValue: AssignmentInventorySnapshot): string {
  const line = formatAssignmentInventorySnapshot(snapshotValue).find((candidate) =>
    candidate.startsWith('[orca-relay] regional rehome inventory ')
  )
  if (!line) throw new Error('the formatter no longer emits a rehome inventory line')
  return line
}

describe('regional rehome inventory line census', () => {
  it('parses what the director actually prints, field for field', async () => {
    const parse = await loadParser()
    const regionalRehomes = {
      active: 3,
      awaitingReceipt: 1,
      targetRegistered: 2,
      completedLast24Hours: 41,
      abortedLast24Hours: 12,
      hostNotArrivedLast24Hours: 5,
      oldestActiveAgeMs: 77_731_209
    }
    const now = Date.parse('2026-09-20T12:00:00Z')

    const evidence = parse(
      [{ timestamp: '2026-09-20T11:59:00Z', textPayload: inventoryLine(snapshot(regionalRehomes)) }],
      { now, maxAgeMs: 5 * 60_000 }
    )

    expect(evidence).toEqual({ ...regionalRehomes })
  })

  it('parses the line an idle fleet prints, with no oldest active age', async () => {
    const parse = await loadParser()
    const now = Date.parse('2026-09-20T12:00:00Z')

    const evidence = parse(
      [
        {
          timestamp: '2026-09-20T11:59:00Z',
          textPayload: inventoryLine(
            snapshot({
              active: 0,
              awaitingReceipt: 0,
              targetRegistered: 0,
              completedLast24Hours: 0,
              abortedLast24Hours: 0,
              hostNotArrivedLast24Hours: 0,
              oldestActiveAgeMs: null
            })
          )
        }
      ],
      { now, maxAgeMs: 5 * 60_000 }
    )

    expect(evidence.oldestActiveAgeMs).toBeNull()
    expect(evidence.hostNotArrivedLast24Hours).toBe(0)
  })

  it('covers every counter the formatter puts on the line', async () => {
    const parse = await loadParser()
    // A field the parser ignores is a field the operator never sees, so the
    // census fails when the formatter gains one and this test is not updated.
    const line = inventoryLine(
      snapshot({
        active: 1,
        awaitingReceipt: 1,
        targetRegistered: 1,
        completedLast24Hours: 1,
        abortedLast24Hours: 1,
        hostNotArrivedLast24Hours: 1,
        oldestActiveAgeMs: 1
      })
    )
    const printed = line
      .slice('[orca-relay] regional rehome inventory '.length)
      .split(' ')
      .map((field) => field.split('=')[0])

    const surfaced = Object.keys(
      parse([{ timestamp: '2026-09-20T11:59:00Z', textPayload: line }], {
        now: Date.parse('2026-09-20T12:00:00Z'),
        maxAgeMs: 5 * 60_000
      })
    )

    expect([...printed].sort()).toEqual([...surfaced].sort())
  })
})
