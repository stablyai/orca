import { describe, expect, it } from 'vitest'
import { C5_PAGE_CLOSURE } from './c5-page-closure'
import { pageClosureDrift, type PageClosureObservation } from './page-closure'

function asPinned(): Map<string, PageClosureObservation> {
  const run = new Map<string, PageClosureObservation>()
  for (const [family, goldens] of Object.entries(C5_PAGE_CLOSURE)) {
    for (const [id, verdict] of Object.entries(goldens)) {
      run.set(id, { family, verdict })
    }
  }
  return run
}

describe('reading a run against the C5 pin', () => {
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
