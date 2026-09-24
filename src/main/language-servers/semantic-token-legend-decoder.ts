// Semantic-token legend decode BY NAME (spike findings §1). clangd's legend
// does NOT match LSP standard names — e.g. `method` (not `function.member`),
// 24 type entries incl. self-invented `unknown`/`bracket`/`label`, 19 modifier
// entries incl. `classScope`/`globalScope`. So the server-returned relative
// 5-tuple is decoded BY NAME here (main process) for IPC; the renderer
// re-encodes by name against the same normalized client set (shared module).
// Unknown type indices map to a skip sentinel so the lexical (Monarch) layer
// colors the identifier.
import type {
  LanguageServerSemanticToken,
  LanguageServerSemanticTokens
} from '../../shared/language-server-navigation-types'
import {
  SEMANTIC_TOKEN_CLIENT_MODIFIERS,
  SEMANTIC_TOKEN_CLIENT_TYPES
} from '../../shared/semantic-token-legend'

// Re-export so the capability declaration (clangd-protocol.ts) reads from one
// module without a second import hop.
export { SEMANTIC_TOKEN_CLIENT_MODIFIERS, SEMANTIC_TOKEN_CLIENT_TYPES }

/** Server legend shape returned in the `semanticTokens/full` `legend` field. */
export type SemanticTokenLegend = {
  /** clangd's token-type names (indexed by the 4th tuple field). */
  tokenTypes: string[]
  /** clangd's modifier names (bitmask-indexed by the 5th tuple field). */
  tokenModifiers: string[]
}

/**
 * Decodes the LSP relative 5-tuple `data` against the server legend into
 * `{line,char,length,type,modifiers[]}` BY NAME. Each 5-tuple is
 * (deltaLine, deltaStartChar, length, tokenTypeIndex, tokenModifiersBitmask).
 * An out-of-range type index → `{ skip: true }` so the renderer drops it and
 * the Monarch lexical layer colors the identifier.
 *
 * Pure + transport-free so it stays unit-testable without clangd.
 */
export function decodeSemanticTokensByLegend(
  data: Uint32Array,
  legend: SemanticTokenLegend
): LanguageServerSemanticToken[] {
  const tokens: LanguageServerSemanticToken[] = []
  // The flat `data` is N*5 entries; a short trailing run (< 5) is malformed
  // and dropped (defensive — clangd always emits complete tuples).
  const tupleCount = Math.floor(data.length / 5)
  for (let i = 0; i < tupleCount; i++) {
    const offset = i * 5
    const line = data[offset] ?? 0
    const char = data[offset + 1] ?? 0
    const length = data[offset + 2] ?? 0
    const typeIndex = data[offset + 3] ?? 0
    const modifiersBitmask = data[offset + 4] ?? 0

    const typeName = legend.tokenTypes[typeIndex]
    if (typeName === undefined) {
      tokens.push({ line, char, length, type: '', modifiers: [], skip: true })
      continue
    }

    const modifiers: string[] = []
    let bits = modifiersBitmask
    let modIndex = 0
    while (bits > 0) {
      if (bits & 1) {
        const modName = legend.tokenModifiers[modIndex]
        if (modName !== undefined) {
          modifiers.push(modName)
        }
      }
      bits >>>= 1
      modIndex += 1
    }

    tokens.push({ line, char, length, type: typeName, modifiers })
  }
  return tokens
}

/** Result shape for textDocument/semanticTokens/full: `{ data: number[] }`. */
type SemanticTokensFullResult = { data?: readonly number[] } | null

/**
 * Maps the `semanticTokens/full` wire result + the captured server legend into
 * the IPC shape `{tokenTypes, tokenModifiers, tokens}`. The flat `data` is the
 * relative 5-tuple array; an absent/short array yields an empty token set so
 * the renderer degrades to lexical (Monarch) coloring. Pure so it stays unit-
 * testable without clangd, and keeps the session module under its line budget.
 */
export function decodeSemanticTokensFullResult(
  result: unknown,
  legend: SemanticTokenLegend
): LanguageServerSemanticTokens {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: semanticTokens/full result is the wire-deserialized LSP payload; `data` is read through optional chaining and Array.isArray-checked before the Uint32Array copy.
  const raw = (result as SemanticTokensFullResult)?.data
  const data = Array.isArray(raw) ? new Uint32Array(raw) : new Uint32Array(0)
  return {
    tokenTypes: legend.tokenTypes,
    tokenModifiers: legend.tokenModifiers,
    tokens: decodeSemanticTokensByLegend(data, legend)
  }
}
