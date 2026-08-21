import { describe, expect, it } from 'vitest'

import { compareExtraction } from './verify-localization-extraction.mjs'

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
})
