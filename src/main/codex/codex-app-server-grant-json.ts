import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'

export const CODEX_APP_SERVER_GRANT_JSON_MAX_STRUCTURAL_TOKENS = 1_000_000
export const CODEX_APP_SERVER_GRANT_JSON_MAX_NESTING_DEPTH = 128

export function parseCodexAppServerGrantJson<T>(text: string): T {
  assertJsonTextStructureWithinLimits(text, {
    structuralTokens: CODEX_APP_SERVER_GRANT_JSON_MAX_STRUCTURAL_TOKENS,
    nestingDepth: CODEX_APP_SERVER_GRANT_JSON_MAX_NESTING_DEPTH
  })
  return JSON.parse(text) as T
}

export function findLastNonEmptyCodexAppServerGrantLine(output: string): string | null {
  let end = output.length
  while (end > 0) {
    const newline = output.lastIndexOf('\n', end - 1)
    const start = newline + 1
    const line = output.slice(start, end)
    if (hasNonWhitespace(line)) {
      return line
    }
    end = newline === -1 ? 0 : newline
  }
  return null
}

function hasNonWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!isEcmaWhitespace(value.charCodeAt(index))) {
      return true
    }
  }
  return false
}

function isEcmaWhitespace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}
