import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  c1PageClosureDrift,
  c1PageClosureExclusions,
  C1_PAGE_CLOSURE,
  type C1PageClosureObservation
} from './c1-page-closure'
import { BRIDGED_PARITY_EXCLUSIONS } from './divergence-classes'

const GOLDENS = resolve(import.meta.dirname, '../../../rpc-foundation/goldens')

/** The run a corpus that diverged exactly as the pin says would hand the rule. */
function asPinned(): Map<string, C1PageClosureObservation> {
  const run = new Map<string, C1PageClosureObservation>()
  for (const [family, goldens] of Object.entries(C1_PAGE_CLOSURE)) {
    for (const [id, verdict] of Object.entries(goldens)) {
      run.set(id, { family, verdict })
    }
  }
  return run
}

describe('the C1 page closure', () => {
  it('is the census the design named: 22 families, 103 goldens', () => {
    const goldens = Object.values(C1_PAGE_CLOSURE).flatMap((family) => Object.keys(family))
    expect({ families: Object.keys(C1_PAGE_CLOSURE).length, goldens: goldens.length }).toEqual({
      families: 22,
      goldens: 103
    })
    expect(new Set(goldens).size).toBe(goldens.length)
  })

  it('pins goldens that exist, in the family the corpus records them under', () => {
    for (const [family, goldens] of Object.entries(C1_PAGE_CLOSURE)) {
      for (const id of Object.keys(goldens)) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every golden carries `family`; a file that does not fails this read and the test.
        const recorded = JSON.parse(readFileSync(`${GOLDENS}/${id}.json`, 'utf8')) as {
          family: string
        }
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
    const exclusions = c1PageClosureExclusions()
    expect(exclusions.length).toBeGreaterThan(0)
    expect(exclusions.filter(([, name]) => BRIDGED_PARITY_EXCLUSIONS[name] === undefined)).toEqual(
      []
    )
  })
})

describe('reading a run against the pin', () => {
  it('says nothing when the run is the pin', () => {
    expect(c1PageClosureDrift(asPinned())).toEqual([])
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
    const drift = c1PageClosureDrift(run)
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
    expect(c1PageClosureDrift(run)).toEqual([`${family}: arrived matrix-arrived-1; left (none)`])
  })

  it('names a closure golden the run stopped producing', () => {
    const run = asPinned()
    const [family, goldens] = Object.entries(C1_PAGE_CLOSURE)[0] ?? []
    const [id] = Object.keys(goldens ?? {})
    if (family === undefined || id === undefined) {
      throw new Error('the pin is empty')
    }
    run.delete(id)
    expect(c1PageClosureDrift(run)).toEqual([`${family}: arrived (none); left ${id}`])
  })

  it('ignores every golden outside the closure, which is most of the corpus', () => {
    const run = asPinned()
    run.set('worktree-catalog-snapshot-unreadable-elsewhere', {
      family: 'session.diff-review',
      verdict: 'result-absent-settlement'
    })
    expect(c1PageClosureDrift(run)).toEqual([])
  })
})
