import { describe, expect, it } from 'vitest'
import {
  SEMANTIC_TOKEN_CLIENT_TYPES,
  SEMANTIC_TOKEN_CLIENT_MODIFIERS,
  decodeSemanticTokensByLegend
} from './semantic-token-legend-decoder'

// A fake clangd-style legend (spike findings §1: clangd's legend does NOT
// match LSP standard names — includes self-invented entries like `unknown`,
// `bracket`, `label` and modifiers like `classScope`/`globalScope`).
const fakeLegend = {
  tokenTypes: ['namespace', 'type', 'class', 'function', 'variable', 'macro', 'enumMember'],
  tokenModifiers: ['declaration', 'definition', 'globalScope', 'classScope']
}

describe('decodeSemanticTokensByLegend', () => {
  it('decodes the relative 5-tuple by legend name into line/char/length/type/modifiers[]', () => {
    // clangd's semanticTokens/full `data` is a flat Uint32Array of 5-tuples
    // (deltaLine, deltaStartChar, length, tokenType index, tokenModifiers bitmask).
    // clangd 23 supports delta; we only use the full (absolute-delta) response.
    const data = new Uint32Array([
      // line 0, char 0, len 4, type 'function'(3), mods declaration(1)+definition(2) => bitmask 0b11
      0,
      0, 4, 3, 0b0011,
      // line 0, char 8, len 5, type 'variable'(4), mod globalScope(4) => bitmask 0b100
      0, 8, 5, 4, 0b0100,
      // line 2, char 0, len 7, type 'type'(1), no mods
      2, 0, 7, 1, 0
    ])

    const tokens = decodeSemanticTokensByLegend(data, fakeLegend)

    expect(tokens).toEqual([
      { line: 0, char: 0, length: 4, type: 'function', modifiers: ['declaration', 'definition'] },
      { line: 0, char: 8, length: 5, type: 'variable', modifiers: ['globalScope'] },
      { line: 2, char: 0, length: 7, type: 'type', modifiers: [] }
    ])
  })

  it('marks an out-of-range token-type index as skip so the renderer drops it (lexical color preserved)', () => {
    // A type index beyond the server legend is malformed; the decoder emits a
    // skip sentinel (empty type) so the renderer drops it and the Monarch
    // lexical layer colors the identifier. (Self-invented names that ARE in
    // the server legend — like clangd's 'unknown'/'bracket' — decode
    // faithfully; the renderer's by-name re-encode skips those that the CLIENT
    // legend does not claim.)
    const data = new Uint32Array([
      // line 0, char 0, len 3, type index 99 (out of range), no mods
      0, 0, 3, 99, 0
    ])

    const tokens = decodeSemanticTokensByLegend(data, fakeLegend)

    expect(tokens).toEqual([{ line: 0, char: 0, length: 3, type: '', modifiers: [], skip: true }])
  })

  it('decodes multiple modifiers in bit-order and ignores out-of-range modifier bits', () => {
    const data = new Uint32Array([
      // type 'function'(3), mods declaration(1)+definition(2)+globalScope(4)+classScope(8)
      //  => bitmask 0b1111, plus a stray high bit 0b100000 (mod index 5, out of range)
      0, 0, 4, 3, 0b111111
    ])

    const tokens = decodeSemanticTokensByLegend(data, fakeLegend)

    expect(tokens[0]?.modifiers).toEqual(['declaration', 'definition', 'globalScope', 'classScope'])
  })

  it('returns an empty list for empty/short data', () => {
    expect(decodeSemanticTokensByLegend(new Uint32Array(0), fakeLegend)).toEqual([])
    expect(decodeSemanticTokensByLegend(new Uint32Array([0, 0, 4]), fakeLegend)).toEqual([])
  })

  it('decodes a self-invented clangd type name that the client legend DOES include', () => {
    // spike: clangd's type list has 24 entries incl. `unknown`/`bracket`/`label`.
    const legendWithSelfInvented = {
      tokenTypes: ['unknown', 'bracket', 'label', 'function'],
      tokenModifiers: ['declaration']
    }
    const data = new Uint32Array([
      0,
      0,
      1,
      0,
      0, // 'unknown'
      0,
      2,
      1,
      1,
      0, // 'bracket'
      0,
      4,
      5,
      3,
      1 // 'function' + declaration
    ])

    const tokens = decodeSemanticTokensByLegend(data, legendWithSelfInvented)

    expect(tokens.map((t) => t.type)).toEqual(['unknown', 'bracket', 'function'])
    expect(tokens[2]?.modifiers).toEqual(['declaration'])
  })
})

describe('SEMANTIC_TOKEN client legend (normalized full set)', () => {
  it('declares the ≥5 identifier classes the acceptance criteria color', () => {
    expect(SEMANTIC_TOKEN_CLIENT_TYPES).toEqual(
      expect.arrayContaining(['function', 'type', 'variable', 'macro', 'enumMember'])
    )
    expect(SEMANTIC_TOKEN_CLIENT_TYPES.length).toBeGreaterThanOrEqual(5)
  })

  it('declares modifiers including the common declaration/definition/globalScope set', () => {
    expect(SEMANTIC_TOKEN_CLIENT_MODIFIERS).toEqual(
      expect.arrayContaining(['declaration', 'definition'])
    )
  })
})
