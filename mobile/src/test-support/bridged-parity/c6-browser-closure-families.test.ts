import { describe, expect, it } from 'vitest'
import { C1_PAGE_CLOSURE } from './c1-page-closure'
import { C2_PAGE_CLOSURE } from './c2-page-closure'
import { C3_PAGE_CLOSURE } from './c3-page-closure'
import { C5_PAGE_CLOSURE } from './c5-page-closure'
import { C6_BROWSER_CLOSURE_FAMILIES } from './c6-browser-closure-families'
import { pageClosureTotals } from './page-closure'

describe('the C6 browser closure half', () => {
  it('is the census the design named: 4 families, 15 goldens', () => {
    const goldens = Object.values(C6_BROWSER_CLOSURE_FAMILIES).flatMap((family) =>
      Object.keys(family)
    )
    expect({
      families: Object.keys(C6_BROWSER_CLOSURE_FAMILIES).length,
      goldens: goldens.length
    }).toEqual({ families: 4, goldens: 15 })
    expect(new Set(goldens).size).toBe(goldens.length)
  })

  /** The counts a per-id walk cannot see move: a table wrong the same way twice agrees with itself. */
  it('pins six byte-identical goldens and nine in one named class', () => {
    expect(pageClosureTotals(C6_BROWSER_CLOSURE_FAMILIES)).toEqual({
      identical: 6,
      'result-absent-settlement': 9
    })
  })

  /**
   * Every family has a byte-identical golden, which is more than C1 or C2 could say of all of
   * theirs: for these four the pin holds bytes and not only the name of a divergence.
   */
  it('leaves no family excluded whole', () => {
    for (const [family, goldens] of Object.entries(C6_BROWSER_CLOSURE_FAMILIES)) {
      expect({ family, identical: Object.values(goldens).includes('identical') }).toEqual({
        family,
        identical: true
      })
    }
  })

  /** C2's rule over the new families, which predicted all fifteen; the table is generated, not
   *  hand-corrected, and this is what says so. */
  it('agrees with the C2 classification rule on every golden', () => {
    for (const goldens of Object.values(C6_BROWSER_CLOSURE_FAMILIES)) {
      for (const [id, verdict] of Object.entries(goldens)) {
        expect({ id, verdict }).toEqual({
          id,
          verdict: id.startsWith('matrix-') ? 'result-absent-settlement' : 'identical'
        })
      }
    }
  })

  /**
   * No family here is pinned by another series, so a golden pinned twice is pinned once.
   *
   * The four are the pane's own and nothing else imports its call sites; `session.browser-tab-create`
   * is recorded at the session screen and belongs to C7.
   */
  it('shares no family with C1, C2, C3 or C5', () => {
    const others = new Set([
      ...Object.keys(C1_PAGE_CLOSURE),
      ...Object.keys(C2_PAGE_CLOSURE),
      ...Object.keys(C3_PAGE_CLOSURE),
      ...Object.keys(C5_PAGE_CLOSURE)
    ])
    expect(Object.keys(C6_BROWSER_CLOSURE_FAMILIES).filter((family) => others.has(family))).toEqual(
      []
    )
  })
})
