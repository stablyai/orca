import { describe, expect, it } from 'vitest'

import {
  buildRuntimeRequiredCatalog,
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
