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
