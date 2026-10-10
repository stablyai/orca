import { describe, expect, it } from 'vitest'

import {
  buildRuntimeRequiredCatalog,
  collectRuntimeRequiredCatalogProblems,
  collectRuntimeRequiredKeys
} from './generate-runtime-required-english-catalog.mjs'

const entries = new Map([
  ['plain.match', 'Save'],
  ['plain.drift', 'Server name'],
  ['plain.conflicting', 'Retry'],
  ['plain.dynamicDefault', 'Connected'],
  ['plain.unreferenced', 'Legacy copy'],
  ['count.thing_one', '{{count}} thing'],
  ['count.thing_other', '{{count}} things']
])

const references = [
  { key: 'plain.match', fallback: 'Save' },
  { key: 'plain.drift', fallback: 'Name in Orca' },
  { key: 'plain.conflicting', fallback: 'Retry' },
  { key: 'plain.conflicting', fallback: 'Try again' },
  { key: 'plain.dynamicDefault', fallback: undefined },
  { key: 'count.thing_one', fallback: '{{count}} thing' }
]

describe('runtime-required English catalog rule', () => {
  it('drops only entries every call site already spells identically', () => {
    expect([...collectRuntimeRequiredKeys(entries, references)].sort()).toEqual([
      'count.thing_one',
      'count.thing_other',
      'plain.conflicting',
      'plain.drift',
      'plain.dynamicDefault',
      'plain.unreferenced'
    ])
  })

  it('keeps a plural entry even when a call site spells it identically', () => {
    expect(collectRuntimeRequiredKeys(entries, references).has('count.thing_one')).toBe(true)
  })

  // The generated file is committed, so a walk-order difference between a
  // contributor's machine and CI would make the gate flap forever.
  it('produces byte-identical output whatever order the call sites are visited in', () => {
    const shuffled = references.toReversed()
    const forward = JSON.stringify(
      buildRuntimeRequiredCatalog(entries, collectRuntimeRequiredKeys(entries, references)),
      null,
      2
    )
    const reversed = JSON.stringify(
      buildRuntimeRequiredCatalog(entries, collectRuntimeRequiredKeys(entries, shuffled)),
      null,
      2
    )

    expect(reversed).toBe(forward)
    // Code-unit order, not locale collation: `sort()` must stay locale-free.
    expect(Object.keys(JSON.parse(forward))).toEqual(['count', 'plain'])
  })

  it('accepts a subset carrying entries that are no longer required', () => {
    const required = collectRuntimeRequiredKeys(entries, references)
    const shipped = new Map([...required].map((key) => [key, entries.get(key)]))
    shipped.set('plain.match', 'Save')

    const problems = collectRuntimeRequiredCatalogProblems(entries, required, shipped)

    expect(problems.missing).toEqual([])
    expect(problems.contradicting).toEqual([])
    expect(problems.superfluous).toEqual(['plain.match'])
  })

  it('rejects a subset that is missing a required entry or contradicts en.json', () => {
    const required = collectRuntimeRequiredKeys(entries, references)
    const shipped = new Map([...required].map((key) => [key, entries.get(key)]))
    shipped.delete('plain.drift')
    shipped.set('plain.conflicting', 'Stale text')

    const problems = collectRuntimeRequiredCatalogProblems(entries, required, shipped)

    expect(problems.missing).toEqual(['plain.drift'])
    expect(problems.contradicting).toEqual(['plain.conflicting'])
  })

  it('rebuilds the nested catalog shape with the English values', () => {
    const required = collectRuntimeRequiredKeys(entries, references)

    expect(buildRuntimeRequiredCatalog(entries, required)).toEqual({
      count: { thing_one: '{{count}} thing', thing_other: '{{count}} things' },
      plain: {
        conflicting: 'Retry',
        drift: 'Server name',
        dynamicDefault: 'Connected',
        unreferenced: 'Legacy copy'
      }
    })
  })
})
