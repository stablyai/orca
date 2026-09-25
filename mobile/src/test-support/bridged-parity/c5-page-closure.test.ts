import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { C5_PAGE_CLOSURE } from './c5-page-closure'
import {
  pageClosureDrift,
  pageClosureExclusions,
  pageClosureTotals,
  type PageClosureObservation
} from './page-closure'
import { C1_PAGE_CLOSURE } from './c1-page-closure'
import { BRIDGED_PARITY_EXCLUSIONS } from './divergence-classes'
import { readGolden } from '../rpc-recording/golden-recording'

const GOLDENS = resolve(import.meta.dirname, '../../../rpc-foundation/goldens')

/** The run a corpus that diverged exactly as the pin says would hand the rule. */
function asPinned(): Map<string, PageClosureObservation> {
  const run = new Map<string, PageClosureObservation>()
  for (const [family, goldens] of Object.entries(C5_PAGE_CLOSURE)) {
    for (const [id, verdict] of Object.entries(goldens)) {
      run.set(id, { family, verdict })
    }
  }
  return run
}

describe('the C5 page closure', () => {
  it('is the census the design named: 25 families, 126 goldens', () => {
    const goldens = Object.values(C5_PAGE_CLOSURE).flatMap((family) => Object.keys(family))
    expect({ families: Object.keys(C5_PAGE_CLOSURE).length, goldens: goldens.length }).toEqual({
      families: 25,
      goldens: 126
    })
    expect(new Set(goldens).size).toBe(goldens.length)
  })

  /**
   * The totals, asserted beside the per-id pins rather than instead of them.
   *
   * A walk that compares each id to its own verdict cannot see a table built wrong in a way that is
   * self-consistent. Deriving this file with a reader that skipped the wrapped entries in
   * `c1-page-closure.ts` produced exactly that: every inherited pin it did read agreed, the
   * mismatch list came back empty, and three `result-absent-stream-release` goldens had quietly
   * become `result-absent-settlement`. The counts are what showed it.
   */
  it('pins how many goldens land in each class, which a per-id walk cannot see move', () => {
    expect(pageClosureTotals(C5_PAGE_CLOSURE)).toEqual({
      identical: 66,
      'result-absent-settlement': 48,
      'params-undefined': 7,
      'result-absent-stream-release': 3,
      'write-ordinal': 2
    })
  })

  it("inherits C1's families whole, with the verdicts C1 committed", () => {
    // Not "the same families": the same goldens in them, at the same verdicts. C2's rule does not
    // reproduce these — it disagrees on 13 of the 103, being `tasks.smart-source-search` 7,
    // `host-worktree-refresh` 5 and `worktree-catalog-snapshot` 1 — so inheritance is the
    // derivation, and this is what says the inheritance happened rather than a re-derivation that
    // looked close. The count is the one C2's and C3's files state; this file said 10 until the
    // derivation was re-run.
    //
    // Compared against the imported object rather than the committed text, which is sound here
    // because `C5_PAGE_CLOSURE` inlines its families instead of spreading C1's: there is no
    // spread for an edited entry to be laundered through. `pinsFromSource` is what the composed
    // tables use.
    for (const [family, pinned] of Object.entries(C1_PAGE_CLOSURE)) {
      expect(C5_PAGE_CLOSURE[family], family).toEqual(pinned)
    }
    expect(Object.keys(C1_PAGE_CLOSURE).length).toBe(20)
  })

  it('adds five families and nothing else, all of them AI Vault', () => {
    const added = Object.keys(C5_PAGE_CLOSURE).filter((family) => !(family in C1_PAGE_CLOSURE))
    expect(added.sort()).toEqual([
      'aiVault.history',
      'aiVault.history-screen',
      'aiVault.resume-launch',
      'aiVault.resume-preparation',
      'settings.resume-metadata'
    ])
  })

  it('has a byte-identical golden in every family it adds, unlike C2 s five', () => {
    // So the pin on each of these means more than "the divergence kept its name".
    const added = Object.entries(C5_PAGE_CLOSURE).filter(([family]) => !(family in C1_PAGE_CLOSURE))
    const wholly = added
      .filter(([, pins]) => !Object.values(pins).includes('identical'))
      .map(([family]) => family)
    expect(wholly).toEqual([])
  })

  it('pins goldens that exist, in the family the corpus records them under', () => {
    for (const [family, goldens] of Object.entries(C5_PAGE_CLOSURE)) {
      for (const id of Object.keys(goldens)) {
        // Through the corpus's own reader, which checks the format version and the value pool and
        // throws a named diagnostic otherwise. The assertion this file wants is about `family`, and
        // asserting the shape in order to read one field made this test the second place that
        // decides what a golden is.
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
    const missing = Object.values(C5_PAGE_CLOSURE)
      .flatMap((family) => Object.keys(family))
      .filter((id) => !corpus.has(id))
    expect(missing).toEqual([])
  })

  it('excludes a closure golden only into a class that has a reason', () => {
    const exclusions = pageClosureExclusions(C5_PAGE_CLOSURE)
    expect(exclusions.length).toBe(60)
    expect(exclusions.filter(([, name]) => BRIDGED_PARITY_EXCLUSIONS[name] === undefined)).toEqual(
      []
    )
  })
})

describe('reading a run against the C5 pin', () => {
  it('says nothing when the run is the pin', () => {
    expect(pageClosureDrift(C5_PAGE_CLOSURE, asPinned())).toEqual([])
  })

  it('names a closure golden that changed verdict', () => {
    const run = asPinned()
    const found = [...run].find(([, seen]) => seen.verdict !== 'params-undefined')
    if (found === undefined) {
      throw new Error('the pin is empty')
    }
    const [id, observation] = found
    run.set(id, { ...observation, verdict: 'params-undefined' })
    const drift = pageClosureDrift(C5_PAGE_CLOSURE, run)
    expect(drift.length).toBe(1)
    expect(drift[0]).toContain(id)
    expect(drift[0]).toContain(`pinned ${observation.verdict}, ran params-undefined`)
  })

  it('names a golden newly derived into a closure family, which no id list would', () => {
    const run = asPinned()
    const [family] = Object.keys(C5_PAGE_CLOSURE)
    if (family === undefined) {
      throw new Error('the pin is empty')
    }
    run.set('matrix-arrived-1', { family, verdict: 'identical' })
    expect(pageClosureDrift(C5_PAGE_CLOSURE, run)).toEqual([
      `${family}: arrived matrix-arrived-1; left (none)`
    ])
  })

  it('names a closure golden the run stopped producing', () => {
    const run = asPinned()
    const [family, goldens] = Object.entries(C5_PAGE_CLOSURE)[0] ?? []
    const [id] = Object.keys(goldens ?? {})
    if (family === undefined || id === undefined) {
      throw new Error('the pin is empty')
    }
    run.delete(id)
    expect(pageClosureDrift(C5_PAGE_CLOSURE, run)).toEqual([
      `${family}: arrived (none); left ${id}`
    ])
  })

  it('ignores every golden outside the closure, which is most of the corpus', () => {
    const run = asPinned()
    run.set('worktree-catalog-snapshot-unreadable-elsewhere', {
      family: 'session.diff-review',
      verdict: 'result-absent-settlement'
    })
    expect(pageClosureDrift(C5_PAGE_CLOSURE, run)).toEqual([])
  })
})
