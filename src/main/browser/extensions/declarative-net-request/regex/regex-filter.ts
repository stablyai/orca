import { MAX_PROGRAM_SIZE } from './regex-piece'
import { translateRe2 } from './regex-translation'

// regexFilter support. Chromium compiles these with RE2 under a 2KB program limit; Orca runs a
// JS RegExp translated from the same pattern and caps size with an estimate of RE2's program.
// Matching runs synchronously on every request, so it must stay linear-time like RE2.

// The translation emits only syntax V8's linear-time engine runs, which main startup turns on
// for runaway backtracking (enableLinearRegexpFallback).

export type DnrRegexOptions = { caseSensitive: boolean; requireCapturing: boolean }

export type DnrRegexTranslation =
  | {
      ok: true
      regex: RegExp
      captureCount: number
      /** Lower-cased literal every match contains; '' when there is none. Used for indexing. */
      requiredLiteral: string
    }
  | { ok: false; reason: 'syntaxError' | 'memoryLimitExceeded' }

/**
 * What a leading ^ saves: RE2 compiles no ".*?" loop for anchored patterns and strips a literal
 * that directly follows the ^ (RE2::Init RequiredPrefix).
 */
function anchorSavings(pattern: string): number {
  if (!pattern.startsWith('^')) {
    return 0
  }
  const match = /^\^((?:[^\\^$.|?*+()[\]{}]|\\[^0-9A-Za-z])+)/.exec(pattern)
  const next = match === null ? undefined : pattern[match[0].length]
  if (match === null || next === '|') {
    return 2
  }
  const length = match[1].replace(/\\(.)/g, '$1').length
  // A quantifier binds the literal's last character, which stays in the program.
  return 1 + (next === '*' || next === '+' || next === '?' || next === '{' ? length - 1 : length)
}

export function translateDnrRegex(pattern: string, options: DnrRegexOptions): DnrRegexTranslation {
  const translation = translateRe2(pattern, options.requireCapturing, !options.caseSensitive)
  if (translation === null) {
    return { ok: false, reason: 'syntaxError' }
  }
  // Fail + Match + the unanchored ".*?" loop, less what an anchor saves.
  if (translation.cost + 4 - anchorSavings(pattern) > MAX_PROGRAM_SIZE) {
    return { ok: false, reason: 'memoryLimitExceeded' }
  }
  let regex: RegExp
  try {
    regex = new RegExp(translation.source)
  } catch {
    return { ok: false, reason: 'syntaxError' }
  }
  return {
    ok: true,
    regex,
    captureCount: translation.captureCount,
    requiredLiteral: translation.requiredLiteral
  }
}

/** chrome.declarativeNetRequest.isRegexSupported. */
export function isDnrRegexSupported(options: {
  regex: string
  isCaseSensitive?: boolean
  requireCapturing?: boolean
}): { isSupported: true } | { isSupported: false; reason: 'syntaxError' | 'memoryLimitExceeded' } {
  const result = translateDnrRegex(options.regex, {
    caseSensitive: options.isCaseSensitive ?? false,
    requireCapturing: options.requireCapturing ?? false
  })
  return result.ok ? { isSupported: true } : { isSupported: false, reason: result.reason }
}

/** RE2::CheckRewriteString: only \0-\9 (within the group count) and \\ are allowed. */
export function isValidRegexSubstitution(substitution: string, captureCount: number): boolean {
  for (let i = 0; i < substitution.length; i++) {
    if (substitution[i] !== '\\') {
      continue
    }
    const next = substitution[++i] ?? ''
    if (next !== '\\' && !(/^\d$/.test(next) && Number(next) <= captureCount)) {
      return false
    }
  }
  return true
}

/** RE2::Replace: rewrites the first match only. */
export function applyRegexSubstitution(
  regex: RegExp,
  input: string,
  substitution: string
): string | null {
  const match = regex.exec(input)
  if (match === null) {
    return null
  }
  const rewritten = substitution.replace(/\\(\\|\d)/g, (_, escaped: string) =>
    escaped === '\\' ? '\\' : (match[Number(escaped)] ?? '')
  )
  return input.slice(0, match.index) + rewritten + input.slice(match.index + match[0].length)
}
