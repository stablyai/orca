import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { C1_PAGE_CLOSURE } from './c1-page-closure'
import { C2_PAGE_CLOSURE } from './c2-page-closure'
import { C2_TASK_SOURCE_CLOSURE_FAMILIES } from './c2-task-source-closure-families'
import { C2_WORK_ITEM_CLOSURE_FAMILIES } from './c2-work-item-closure-families'
import { C5_PAGE_CLOSURE } from './c5-page-closure'
import { BRIDGED_PARITY_EXCLUSIONS } from './divergence-classes'
import {
  pageClosureDrift,
  pageClosureExclusions,
  pageClosureRunTotals,
  pageClosureTotals,
  type PageClosureObservation
} from './page-closure'
import { readGolden } from '../rpc-recording/golden-recording'

const GOLDENS = resolve(import.meta.dirname, '../../../rpc-foundation/goldens')

/** The run a corpus that diverged exactly as the pin says would hand the rule. */
function asPinned(): Map<string, PageClosureObservation> {
  const run = new Map<string, PageClosureObservation>()
  for (const [family, goldens] of Object.entries(C2_PAGE_CLOSURE)) {
    for (const [id, verdict] of Object.entries(goldens)) {
      run.set(id, { family, verdict })
    }
  }
  return run
}

describe('the C2 page closure', () => {
  it('is the census the design named: 70 families, 266 goldens', () => {
    const goldens = Object.values(C2_PAGE_CLOSURE).flatMap((family) => Object.keys(family))
    expect({ families: Object.keys(C2_PAGE_CLOSURE).length, goldens: goldens.length }).toEqual({
      families: 70,
      goldens: 266
    })
    expect(new Set(goldens).size).toBe(goldens.length)
  })

  /**
   * The totals, asserted beside the per-id pins rather than instead of them.
   *
   * A walk that compares each id to its own verdict cannot see a table built wrong in a way that is
   * self-consistent — C5 derived exactly that file once, with an empty mismatch list and three
   * goldens in the wrong class. These counts are what showed it, and the gate re-asserts them
   * against the run rather than against the table.
   */
  it('pins how many goldens land in each class, which a per-id walk cannot see move', () => {
    expect(pageClosureTotals(C2_PAGE_CLOSURE)).toEqual({
      identical: 114,
      'result-absent-settlement': 118,
      'params-undefined': 29,
      'result-absent-stream-release': 3,
      'write-ordinal': 2
    })
  })

  it("inherits C1's families whole, with the verdicts C1 committed", () => {
    // Not "the same families": the same goldens in them, at the same verdicts. C2's own rule does
    // not reproduce these — it disagrees on 10 of the 103 — so inheritance is the derivation, and
    // this is what says the inheritance happened rather than a re-derivation that looked close.
    for (const [family, pinned] of Object.entries(C1_PAGE_CLOSURE)) {
      expect(C2_PAGE_CLOSURE[family], family).toEqual(pinned)
    }
    expect(Object.keys(C1_PAGE_CLOSURE).length).toBe(22)
  })

  it('agrees with C5 object for object on every family both domains pin', () => {
    // Two page closures that share a family share the goldens in it. Were one to be re-derived and
    // the other inherited, this is the assertion that would not hold.
    const shared = Object.keys(C5_PAGE_CLOSURE).filter((family) => family in C2_PAGE_CLOSURE)
    expect(shared.length).toBe(22)
    for (const family of shared) {
      expect(C2_PAGE_CLOSURE[family], family).toEqual(C5_PAGE_CLOSURE[family])
    }
  })

  it('adds 48 families, split across the two halves without overlap', () => {
    // The composed table is a spread, so a family named in both halves would be taken from the last
    // one silently. Disjointness is what makes the two files data rather than a precedence rule.
    const work = Object.keys(C2_WORK_ITEM_CLOSURE_FAMILIES)
    const source = Object.keys(C2_TASK_SOURCE_CLOSURE_FAMILIES)
    expect(work.filter((family) => source.includes(family))).toEqual([])
    expect(work.filter((family) => family in C1_PAGE_CLOSURE)).toEqual([])
    expect(source.filter((family) => family in C1_PAGE_CLOSURE)).toEqual([])
    expect({ work: work.length, source: source.length }).toEqual({ work: 26, source: 22 })
    const added = Object.keys(C2_PAGE_CLOSURE).filter((family) => !(family in C1_PAGE_CLOSURE))
    expect(added.sort()).toEqual([...work, ...source].sort())
  })

  it('names the families where a pin proves only that the divergence kept its name', () => {
    // "266 certified" would read as 266 proofs of byte-identity. Six families have no byte-identical
    // golden at all, so their 27 say only that the class did not change, and the PR body says so.
    const wholly = Object.entries(C2_PAGE_CLOSURE)
      .filter(([, pins]) => !Object.values(pins).includes('identical'))
      .map(([family, pins]) => [family, Object.keys(pins).length] as const)
    expect(wholly).toEqual([
      ['host-worktree-refresh', 5],
      ['tasks.item-checks-files', 6],
      ['tasks.item-metadata-gitlab-mr', 2],
      ['tasks.project-row-files-merge', 6],
      ['tasks.provider-load', 6],
      ['tasks.task-list-gitlab-items', 2]
    ])
  })

  it('pins goldens that exist, in the family the corpus records them under', () => {
    for (const [family, goldens] of Object.entries(C2_PAGE_CLOSURE)) {
      for (const id of Object.keys(goldens)) {
        // Through the corpus's own reader, which checks the format version and the value pool and
        // throws a named diagnostic otherwise.
        const recorded = readGolden(GOLDENS, id)
        expect({ id, family: recorded.family }).toEqual({ id, family })
      }
    }
  })

  it('claims no golden the corpus does not have', () => {
    const corpus = new Set(
      readdirSync(GOLDENS)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/\.json$/, ''))
    )
    const missing = Object.values(C2_PAGE_CLOSURE)
      .flatMap((family) => Object.keys(family))
      .filter((id) => !corpus.has(id))
    expect(missing).toEqual([])
  })

  it('excludes a closure golden only into a class that has a reason', () => {
    const exclusions = pageClosureExclusions(C2_PAGE_CLOSURE)
    expect(exclusions.length).toBe(152)
    expect(exclusions.filter(([, name]) => BRIDGED_PARITY_EXCLUSIONS[name] === undefined)).toEqual(
      []
    )
  })
})

describe('reading a run against the C2 pin', () => {
  it('says nothing when the run is the pin', () => {
    expect(pageClosureDrift(C2_PAGE_CLOSURE, asPinned())).toEqual([])
    expect(pageClosureRunTotals(C2_PAGE_CLOSURE, asPinned())).toEqual(
      pageClosureTotals(C2_PAGE_CLOSURE)
    )
  })

  it('names a closure golden that changed verdict', () => {
    const run = asPinned()
    const found = [...run].find(([, seen]) => seen.verdict !== 'params-undefined')
    if (found === undefined) {
      throw new Error('the pin is empty')
    }
    const [id, observation] = found
    run.set(id, { ...observation, verdict: 'params-undefined' })
    const drift = pageClosureDrift(C2_PAGE_CLOSURE, run)
    expect(drift.length).toBe(1)
    expect(drift[0]).toContain(id)
    expect(drift[0]).toContain(`pinned ${observation.verdict}, ran params-undefined`)
    // And in the counts, which is the check that holds when a second golden moves the other way.
    expect(pageClosureRunTotals(C2_PAGE_CLOSURE, run)).not.toEqual(
      pageClosureTotals(C2_PAGE_CLOSURE)
    )
  })

  it('names a golden newly derived into a closure family, which no id list would', () => {
    const run = asPinned()
    const [family] = Object.keys(C2_PAGE_CLOSURE)
    if (family === undefined) {
      throw new Error('the pin is empty')
    }
    run.set('matrix-arrived-1', { family, verdict: 'identical' })
    expect(pageClosureDrift(C2_PAGE_CLOSURE, run)).toEqual([
      `${family}: arrived matrix-arrived-1; left (none)`
    ])
  })

  it('names a closure golden the run stopped producing, three ways', () => {
    const run = asPinned()
    const [family, goldens] = Object.entries(C2_PAGE_CLOSURE)[0] ?? []
    const [id] = Object.keys(goldens ?? {})
    if (family === undefined || id === undefined) {
      throw new Error('the pin is empty')
    }
    run.delete(id)
    expect(pageClosureDrift(C2_PAGE_CLOSURE, run)).toEqual([
      `${family}: arrived (none); left ${id}`
    ])
    // Drift is one of three. The run's totals fall short of the pin's, and the census above fixes
    // the number of goldens the table may hold, so a drop cannot be absorbed by deleting the pin.
    expect(pageClosureRunTotals(C2_PAGE_CLOSURE, run)).not.toEqual(
      pageClosureTotals(C2_PAGE_CLOSURE)
    )
    expect([...run].filter(([, seen]) => seen.family in C2_PAGE_CLOSURE).length).toBe(265)
  })

  it('ignores every golden outside the closure, which is most of the corpus', () => {
    const run = asPinned()
    run.set('session-diff-review-elsewhere', {
      family: 'session.diff-review',
      verdict: 'result-absent-settlement'
    })
    expect(pageClosureDrift(C2_PAGE_CLOSURE, run)).toEqual([])
  })
})
