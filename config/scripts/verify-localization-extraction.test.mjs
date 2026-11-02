import { describe, expect, it } from 'vitest'

import {
  collectKeyLiterals,
  compareExtraction,
  findUnreferencedKeys
} from './verify-localization-extraction.mjs'

function sourceEvidence(sourceText) {
  return collectKeyLiterals(sourceText, { literals: new Set(), dynamicPrefixes: new Set() })
}

describe('verify-localization-extraction', () => {
  it('reports legacy drift without requiring a committed disposition database', () => {
    const result = compareExtraction(
      { menu: { open: 'Open now {{name}}' } },
      { menu: { open: 'Open {{name}}', legacy: 'Legacy copy' } }
    )

    expect(result.orphans).toEqual(['menu.legacy'])
    expect(result.fallbackDrift).toEqual(['menu.open'])
    expect(result.placeholderMismatches).toEqual([])
  })

  it('reports dynamic defaults without treating empty extractor values as catalog copy', () => {
    const result = compareExtraction(
      { menu: { dynamic: '' } },
      { menu: { dynamic: '{{count}} items' } }
    )

    expect(result.dynamicDefaults).toEqual(['menu.dynamic'])
    expect(result.fallbackDrift).toEqual([])
    expect(result.placeholderMismatches).toEqual([])
  })

  it('rejects undeclared keys even when their defaults are dynamic', () => {
    const result = compareExtraction({ menu: { dynamic: '' } }, {})

    expect(result.missingFromEnglish).toEqual(['menu.dynamic'])
  })

  it('rejects missing English declarations and incompatible placeholders', () => {
    const result = compareExtraction(
      {
        menu: {
          missing: 'Missing',
          open: 'Open {{name}}'
        }
      },
      { menu: { open: 'Open {{path}}' } }
    )

    expect(result.missingFromEnglish).toEqual(['menu.missing'])
    expect(result.placeholderMismatches).toEqual(['menu.open'])
  })

  it('tracks both plural defaults and keeps count-only keys singular', () => {
    const result = compareExtraction(
      {
        files_one: '{{count}} file',
        files_other: '{{count}} files',
        selected_one: '{{count}} selected',
        selected_other: '{{count}} selected'
      },
      { files_one: 'One file', files_other: '{{count}} files', selected: '{{count}} selected' }
    )

    expect(result.missingFromEnglish).toEqual([])
    expect(result.fallbackDrift).toEqual(['files_one'])

    const dynamic = compareExtraction(
      { bg: { tasks_other: 'bg.tasks' } },
      { bg: { tasks_other: '{{count}} tasks' } }
    )
    expect(dynamic.dynamicDefaults).toEqual(['bg.tasks_other'])
  })

  it('keeps plural variants and data-structure keys that extraction cannot see', () => {
    const evidence = sourceEvidence("const rows = [{ labelKey: 'rows.held' }]")
    const extracted = new Map([['menu.count', '']])

    expect(
      findUnreferencedKeys(
        ['menu.count_one', 'menu.count_other', 'rows.held', 'rows.dead_one', 'menu.stale'],
        extracted,
        evidence
      )
    ).toEqual(['rows.dead_one', 'menu.stale'])
  })

  it('keeps keys under a prefix that a translate call composes at runtime', () => {
    const evidence = sourceEvidence(
      "translate(`status.label.${state}`)\nt('menu.item.' + id)\nconst id = `rpc.${method}`"
    )

    expect(
      findUnreferencedKeys(
        ['status.label.ready', 'menu.item.open', 'rpc.ping'],
        new Map(),
        evidence
      )
    ).toEqual(['rpc.ping'])
  })
})
