import { describe, expect, it } from 'vitest'
import { OBJECT_PACK_MERGE_MAX_OBJECTS } from '../../shared/repo-maintenance-policy'
import type { KeptLooseObjectPack } from './loose-object-pack-keep'
import { planObjectPackHousekeeping } from './object-pack-housekeeping-maintenance-task'

const DAY_MS = 24 * 60 * 60_000
const TODAY = 20_000 * DAY_MS

function pack(name: string, overrides: Partial<KeptLooseObjectPack> = {}): KeptLooseObjectPack {
  return {
    name,
    hashHexLength: 40,
    mtimeMs: TODAY,
    objectCount: 100,
    orphaned: false,
    ...overrides
  }
}

const names = (packs: readonly KeptLooseObjectPack[]): string[] => packs.map((p) => p.name)

describe('object pack housekeeping plan', () => {
  it('owes nothing for a single pack', () => {
    expect(planObjectPackHousekeeping([pack('a')], TODAY - DAY_MS)).toEqual({
      release: [],
      merges: [],
      owed: 0
    })
  })

  it('releases packs at or past the cutoff, and keeps orphaned keeps from piling up', () => {
    const plan = planObjectPackHousekeeping(
      [
        pack('expired', { mtimeMs: TODAY - 2 * DAY_MS }),
        pack('orphan', { orphaned: true, objectCount: undefined }),
        pack('young')
      ],
      TODAY - DAY_MS
    )

    expect(names(plan.release)).toEqual(['expired', 'orphan'])
    expect(plan.owed).toBe(2)
  })

  it('merges by day, and across days only when nothing ever expires', () => {
    const packs = [pack('yesterday', { mtimeMs: TODAY - DAY_MS }), pack('today-1'), pack('today-2')]

    const byDay = planObjectPackHousekeeping(packs, TODAY - 14 * DAY_MS)
    expect(byDay.merges.map(names)).toEqual([['today-1', 'today-2']])
    expect(byDay.owed).toBe(1)

    const forever = planObjectPackHousekeeping(packs, null)
    expect(forever.merges.map(names)).toEqual([['yesterday', 'today-1', 'today-2']])
    expect(forever.owed).toBe(2)
  })

  it('caps a merge by object count, but always merges at least two', () => {
    const half = OBJECT_PACK_MERGE_MAX_OBJECTS / 2
    const plan = planObjectPackHousekeeping(
      [
        pack('a', { objectCount: half + 1 }),
        pack('b', { objectCount: half + 1 }),
        pack('c', { objectCount: 1 })
      ],
      null
    )

    expect(plan.merges.map(names)).toEqual([['a', 'b']])
    // The rest stays owed, so the scheduler comes back for it.
    expect(plan.owed).toBe(2)
  })

  it('leaves full packs and unreadable indexes out of any merge', () => {
    const plan = planObjectPackHousekeeping(
      [
        pack('full', { objectCount: OBJECT_PACK_MERGE_MAX_OBJECTS }),
        pack('unreadable', { objectCount: undefined }),
        pack('small')
      ],
      null
    )

    expect(plan).toEqual({ release: [], merges: [], owed: 0 })
  })
})
