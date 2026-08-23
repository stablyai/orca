import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  collectElectronImporters,
  diffAgainstBaseline,
  readBaseline
} from './check-runtime-electron-ratchet.mjs'

describe('readBaseline', () => {
  it('drops comments and blank lines and sorts, so baseline formatting cannot cause a false diff', () => {
    expect(readBaseline('# header\n\n  b/second.ts \na/first.ts\n')).toEqual([
      'a/first.ts',
      'b/second.ts'
    ])
  })
})

describe('diffAgainstBaseline', () => {
  it('reports a module that started importing electron', () => {
    expect(diffAgainstBaseline(['a.ts', 'b.ts'], ['a.ts'])).toEqual({
      added: ['b.ts'],
      removed: []
    })
  })

  it('reports a module that stopped, so the baseline is forced to tighten rather than drift', () => {
    expect(diffAgainstBaseline(['a.ts'], ['a.ts', 'b.ts'])).toEqual({
      added: [],
      removed: ['b.ts']
    })
  })

  it('is quiet when the set is unchanged', () => {
    expect(diffAgainstBaseline(['a.ts'], ['a.ts'])).toEqual({ added: [], removed: [] })
  })
})

describe('the checked-in baseline', () => {
  // Why real: the value of this gate is the transitive edges, which a fixture cannot model.
  // If this is slow enough to hurt, it is still cheaper than shipping a runtime that
  // cannot boot on Node.
  it('matches what the runtime actually reaches today', async () => {
    const current = await collectElectronImporters()
    const baseline = readBaseline(readFileSync('config/runtime-electron-baseline.txt', 'utf8'))
    expect(diffAgainstBaseline(current, baseline)).toEqual({ added: [], removed: [] })
  }, 120_000)

  it('only lists modules under src/, so a node_modules path cannot pad the count', () => {
    const baseline = readBaseline(readFileSync('config/runtime-electron-baseline.txt', 'utf8'))
    expect(baseline.length).toBeGreaterThan(0)
    expect(baseline.filter((entry) => !entry.startsWith('src/'))).toEqual([])
  })
})
