import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { C1_PAGE_CLOSURE } from './c1-page-closure'
import { C2_PAGE_CLOSURE } from './c2-page-closure'
import { C3_PAGE_CLOSURE } from './c3-page-closure'
import { C3_EXPLORER_CLOSURE_FAMILIES } from './c3-explorer-closure-families'
import { C3_PREVIEW_CLOSURE_FAMILIES } from './c3-preview-closure-families'
import { C5_PAGE_CLOSURE } from './c5-page-closure'
import { pinsFromSource } from './page-closure-pin-source'
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
const C1_SOURCE = resolve(import.meta.dirname, 'c1-page-closure.ts')

/** The run a corpus that diverged exactly as the pin says would hand the rule. */
function asPinned(): Map<string, PageClosureObservation> {
  const run = new Map<string, PageClosureObservation>()
  for (const [family, goldens] of Object.entries(C3_PAGE_CLOSURE)) {
    for (const [id, verdict] of Object.entries(goldens)) {
      run.set(id, { family, verdict })
    }
  }
  return run
}

describe('the C3 page closure', () => {
  /**
   * The census reads the committed table, and does not re-derive the closure.
   *
   * Nothing here or in the gate runs esbuild or maps a scenario's `sites` back to the module graph,
   * so this fixes how many families the table may hold, not which families belong in it. A golden
   * arriving in a family already pinned is caught, by `pageClosureDrift` and by this count. A new
   * *family* entering the closure is invisible until someone re-derives it by hand — which
   * `config/scripts/mobile-web-app-page-closure-families.test.mjs` now does for both files routes.
   */
  it('is the census the design named: 28 families, 125 goldens', () => {
    const goldens = Object.values(C3_PAGE_CLOSURE).flatMap((family) => Object.keys(family))
    expect({ families: Object.keys(C3_PAGE_CLOSURE).length, goldens: goldens.length }).toEqual({
      families: 28,
      goldens: 125
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
    expect(pageClosureTotals(C3_PAGE_CLOSURE)).toEqual({
      identical: 66,
      'result-absent-settlement': 47,
      'params-undefined': 7,
      'result-absent-stream-release': 3,
      'write-ordinal': 2
    })
  })

  it("inherits C1's families whole, with the verdicts C1's file commits", () => {
    // Against the file's text rather than the imported object: the composition spreads that object,
    // so a hand-edited inherited entry would be read back as C1's and agree with itself.
    //
    // What this cannot see is an edit to `c1-page-closure.ts` itself, because both sides of the
    // comparison then move together. What it does see is a C3 half redeclaring an inherited family,
    // which the spread would otherwise take silently from the last table. Both measured: flipping
    // `settings-repo-metadata-icons` in C1's file leaves this case green and reds seven others —
    // the class totals and the exclusion counts in C2's suite and this one, both cross-series
    // agreements, and C5's own inheritance case, which compares against an independent literal
    // rather than a spread.
    //
    // Redeclaring `settings.repo-metadata` in the preview half always reds this case; how many
    // others go with it depends on the shape of the redeclaration, so the number is not the claim.
    // Measured: one golden under the family's name reds seven, because it also shrinks the census
    // to 114 and leaves that family with no byte-identical golden. The family copied verbatim with
    // a single verdict flipped reds five, the census unmoved at 125. Both keep the load-bearing
    // half — the spread takes the last table's entry, and this case is what sees it.
    //
    // C2's rule does not reproduce these pins — measured here, it disagrees on 13 of the 103,
    // being `tasks.smart-source-search` 7, `host-worktree-refresh` 5 and
    // `worktree-catalog-snapshot` 1 — so inheritance is the derivation rather than a
    // re-derivation that looked close.
    const committed = pinsFromSource(C1_SOURCE)
    expect({
      families: Object.keys(committed).length,
      pins: Object.values(committed).flatMap(Object.keys).length
    }).toEqual({ families: 22, pins: 103 })
    for (const [family, pinned] of Object.entries(committed)) {
      expect(C3_PAGE_CLOSURE[family], family).toEqual(pinned)
    }
  })

  it('agrees with C2 and C5 object for object on every family they share', () => {
    // Three page closures that share a family share the goldens in it. Were one re-derived and the
    // others inherited, this is the assertion that would not hold.
    for (const [name, other] of [
      ['C2', C2_PAGE_CLOSURE],
      ['C5', C5_PAGE_CLOSURE]
    ] as const) {
      const shared = Object.keys(other).filter((family) => family in C3_PAGE_CLOSURE)
      expect(shared.length, name).toBe(22)
      for (const family of shared) {
        expect(C3_PAGE_CLOSURE[family], `${name}/${family}`).toEqual(other[family])
      }
    }
  })

  it('adds 6 families, split across the two routes without overlap', () => {
    // The composed table is a spread, so a family named in both halves would be taken from the last
    // one silently. Disjointness is what makes the two files data rather than a precedence rule.
    const explorer = Object.keys(C3_EXPLORER_CLOSURE_FAMILIES)
    const preview = Object.keys(C3_PREVIEW_CLOSURE_FAMILIES)
    expect(explorer.filter((family) => preview.includes(family))).toEqual([])
    expect(explorer.filter((family) => family in C1_PAGE_CLOSURE)).toEqual([])
    expect(preview.filter((family) => family in C1_PAGE_CLOSURE)).toEqual([])
    expect({ explorer: explorer.length, preview: preview.length }).toEqual({
      explorer: 1,
      preview: 5
    })
    const added = Object.keys(C3_PAGE_CLOSURE).filter((family) => !(family in C1_PAGE_CLOSURE))
    expect(added.sort()).toEqual([...explorer, ...preview].sort())
  })

  it('names the families where a pin proves only that the divergence kept its name', () => {
    // "125 certified" would read as 125 proofs of byte-identity. One family has no byte-identical
    // golden at all, so its 5 say only that the class did not change, and the PR body says so.
    const wholly = Object.entries(C3_PAGE_CLOSURE)
      .filter(([, pins]) => !Object.values(pins).includes('identical'))
      .map(([family, pins]) => [family, Object.keys(pins).length] as const)
    expect(wholly).toEqual([['host-worktree-refresh', 5]])
  })

  it('pins goldens that exist, in the family the corpus records them under', () => {
    for (const [family, goldens] of Object.entries(C3_PAGE_CLOSURE)) {
      for (const id of Object.keys(goldens)) {
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
    const missing = Object.values(C3_PAGE_CLOSURE)
      .flatMap((family) => Object.keys(family))
      .filter((id) => !corpus.has(id))
    expect(missing).toEqual([])
  })

  it('excludes a closure golden only into a class that has a reason', () => {
    const exclusions = pageClosureExclusions(C3_PAGE_CLOSURE)
    expect(exclusions.length).toBe(59)
    expect(exclusions.filter(([, name]) => BRIDGED_PARITY_EXCLUSIONS[name] === undefined)).toEqual(
      []
    )
  })
})

describe('reading a run against the C3 pin', () => {
  it('says nothing when the run is the pin', () => {
    expect(pageClosureDrift(C3_PAGE_CLOSURE, asPinned())).toEqual([])
    expect(pageClosureRunTotals(C3_PAGE_CLOSURE, asPinned())).toEqual(
      pageClosureTotals(C3_PAGE_CLOSURE)
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
    const drift = pageClosureDrift(C3_PAGE_CLOSURE, run)
    expect(drift.length).toBe(1)
    expect(drift[0]).toContain(id)
    expect(drift[0]).toContain(`pinned ${observation.verdict}, ran params-undefined`)
  })

  it('names a golden the run stopped producing, and moves the totals with it', () => {
    const run = asPinned()
    const [family, goldens] = Object.entries(C3_PAGE_CLOSURE)[0] ?? []
    const [id] = Object.keys(goldens ?? {})
    if (family === undefined || id === undefined) {
      throw new Error('the pin is empty')
    }
    run.delete(id)
    expect(pageClosureDrift(C3_PAGE_CLOSURE, run)).toEqual([
      `${family}: arrived (none); left ${id}`
    ])
    // The totals move too, which is the half a per-id walk over what remains cannot see.
    expect(pageClosureRunTotals(C3_PAGE_CLOSURE, run)).not.toEqual(
      pageClosureTotals(C3_PAGE_CLOSURE)
    )
  })

  it('ignores every golden outside the closure, which is most of the corpus', () => {
    const run = asPinned()
    run.set('a-golden-from-another-domain', {
      family: 'session.diff-review',
      verdict: 'result-absent-settlement'
    })
    expect(pageClosureDrift(C3_PAGE_CLOSURE, run)).toEqual([])
  })
})
