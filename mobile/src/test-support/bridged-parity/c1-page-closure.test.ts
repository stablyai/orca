import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { C1_PAGE_CLOSURE } from './c1-page-closure'
import {
  pageClosureDrift,
  pageClosureExclusions,
  type PageClosureObservation
} from './page-closure'
import { BRIDGED_PARITY_EXCLUSIONS } from './divergence-classes'
import { readGolden } from '../rpc-recording/golden-recording'

const GOLDENS = resolve(import.meta.dirname, '../../../rpc-foundation/goldens')

/** The run a corpus that diverged exactly as the pin says would hand the rule. */
function asPinned(): Map<string, PageClosureObservation> {
  const run = new Map<string, PageClosureObservation>()
  for (const [family, goldens] of Object.entries(C1_PAGE_CLOSURE)) {
    for (const [id, verdict] of Object.entries(goldens)) {
      run.set(id, { family, verdict })
    }
  }
  return run
}

describe('the C1 page closure', () => {
  it('is the census the design named: 20 families, 94 goldens', () => {
    const goldens = Object.values(C1_PAGE_CLOSURE).flatMap((family) => Object.keys(family))
    expect({ families: Object.keys(C1_PAGE_CLOSURE).length, goldens: goldens.length }).toEqual({
      families: 20,
      goldens: 94
    })
    expect(new Set(goldens).size).toBe(goldens.length)
  })

  it('pins goldens that exist, in the family the corpus records them under', () => {
    for (const [family, goldens] of Object.entries(C1_PAGE_CLOSURE)) {
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
    const missing = Object.values(C1_PAGE_CLOSURE)
      .flatMap((family) => Object.keys(family))
      .filter((id) => !corpus.has(id))
    expect(missing).toEqual([])
  })

  it('excludes a closure golden only into a class that has a reason', () => {
    const exclusions = pageClosureExclusions(C1_PAGE_CLOSURE)
    expect(exclusions.length).toBeGreaterThan(0)
    expect(exclusions.filter(([, name]) => BRIDGED_PARITY_EXCLUSIONS[name] === undefined)).toEqual(
      []
    )
  })
})

describe('reading a run against the pin', () => {
  it('says nothing when the run is the pin', () => {
    expect(pageClosureDrift(C1_PAGE_CLOSURE, asPinned())).toEqual([])
  })

  it('names a closure golden that changed verdict', () => {
    const run = asPinned()
    // Whichever golden it is, the verdict it moves to has to be one it is not already pinned to.
    const found = [...run].find(([, seen]) => seen.verdict !== 'params-undefined')
    if (found === undefined) {
      throw new Error('the pin is empty')
    }
    const [id, observation] = found
    run.set(id, { ...observation, verdict: 'params-undefined' })
    const drift = pageClosureDrift(C1_PAGE_CLOSURE, run)
    expect(drift.length).toBe(1)
    expect(drift[0]).toContain(id)
    expect(drift[0]).toContain(`pinned ${observation.verdict}, ran params-undefined`)
  })

  it('names a golden newly derived into a closure family, which no id list would', () => {
    const run = asPinned()
    const [family] = Object.keys(C1_PAGE_CLOSURE)
    if (family === undefined) {
      throw new Error('the pin is empty')
    }
    run.set('matrix-arrived-1', { family, verdict: 'identical' })
    expect(pageClosureDrift(C1_PAGE_CLOSURE, run)).toEqual([
      `${family}: arrived matrix-arrived-1; left (none)`
    ])
  })

  it('names a closure golden the run stopped producing', () => {
    const run = asPinned()
    const [family, goldens] = Object.entries(C1_PAGE_CLOSURE)[0] ?? []
    const [id] = Object.keys(goldens ?? {})
    if (family === undefined || id === undefined) {
      throw new Error('the pin is empty')
    }
    run.delete(id)
    expect(pageClosureDrift(C1_PAGE_CLOSURE, run)).toEqual([
      `${family}: arrived (none); left ${id}`
    ])
  })

  it('ignores every golden outside the closure, which is most of the corpus', () => {
    const run = asPinned()
    run.set('worktree-catalog-snapshot-unreadable-elsewhere', {
      family: 'session.diff-review',
      verdict: 'result-absent-settlement'
    })
    expect(pageClosureDrift(C1_PAGE_CLOSURE, run)).toEqual([])
  })
})
