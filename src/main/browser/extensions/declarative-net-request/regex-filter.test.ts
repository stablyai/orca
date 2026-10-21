import { describe, expect, it } from 'vitest'
import {
  applyRegexSubstitution,
  isDnrRegexSupported,
  isValidRegexSubstitution,
  translateDnrRegex
} from './regex-filter'

const verdict = (regex: string): string => {
  const result = isDnrRegexSupported({ regex })
  return result.isSupported ? 'ok' : result.reason
}

const compile = (pattern: string, caseSensitive = false, requireCapturing = false): RegExp => {
  const result = translateDnrRegex(pattern, { caseSensitive, requireCapturing })
  if (!result.ok) {
    throw new Error(`unsupported ${pattern}`)
  }
  return result.regex
}

// Expected verdicts come from chrome.declarativeNetRequest.isRegexSupported in Electron 43
// (Chromium 150's RE2), except where noted.
describe('isDnrRegexSupported syntax', () => {
  it.each([
    ['a(?=b)', 'syntaxError'],
    ['a(?!b)', 'syntaxError'],
    ['(?<=a)b', 'syntaxError'],
    ['(?<!a)b', 'syntaxError'],
    ['(a)\\1', 'syntaxError'],
    ['\\k<n>', 'syntaxError'],
    ['a**', 'syntaxError'],
    ['a*?', 'ok'],
    ['a*??', 'syntaxError'],
    ['a+*', 'syntaxError'],
    ['a{2}*', 'syntaxError'],
    ['a{2,1}', 'syntaxError'],
    ['a{1001}', 'syntaxError'],
    ['*a', 'syntaxError'],
    ['a|*b', 'syntaxError'],
    ['(*)', 'syntaxError'],
    ['{2}a', 'syntaxError'],
    ['^*', 'ok'],
    ['\\Z', 'syntaxError'],
    ['\\z', 'ok'],
    ['\\A', 'ok'],
    ['\\Q.*\\E+', 'ok'],
    ['(?i)abc', 'ok'],
    ['(?i:abc)def', 'ok'],
    ['(?P<name>x)', 'ok'],
    ['(?<name>x)', 'ok'],
    ['(?#comment)', 'syntaxError'],
    ['(?)', 'ok'],
    ['(?i-)', 'syntaxError'],
    ['(?i-s:x)', 'ok'],
    ['[[:alpha:]]+', 'ok'],
    ['[[:foo:]]', 'syntaxError'],
    ['[[:^digit:]]', 'ok'],
    ['\\p', 'syntaxError'],
    ['[\\d-z]', 'ok'],
    ['[a-]', 'ok'],
    ['[]a]', 'ok'],
    ['[^]a]', 'ok'],
    ['[z-a]', 'syntaxError'],
    ['[a', 'syntaxError'],
    ['a)', 'syntaxError'],
    ['(a', 'syntaxError'],
    ['\\x41', 'ok'],
    ['\\x4', 'syntaxError'],
    ['\\x{41}', 'ok'],
    ['\\x{100}', 'syntaxError'],
    ['\\101', 'ok'],
    ['\\8', 'syntaxError'],
    ['\\0', 'ok'],
    ['\\e', 'syntaxError'],
    ['\\_', 'ok'],
    ['\\/', 'ok'],
    ['[\\b]', 'syntaxError'],
    ['\\cA', 'syntaxError'],
    ['\\u0041', 'syntaxError'],
    ['(?s).', 'ok'],
    ['\\C', 'ok'],
    ['a{,5}', 'ok'],
    ['a{01}', 'ok'],
    // RE2 accepts these; JS or V8's linear-time engine cannot run them the same way.
    ['\\pL', 'syntaxError'],
    ['(?U)a*', 'syntaxError'],
    ['(a){17}', 'syntaxError'],
    ['(?:(?:(?:(?:(?:a*)+)+)+)+)+', 'syntaxError']
  ])('%s → %s', (pattern, expected) => {
    expect(verdict(pattern)).toBe(expected)
  })
})

describe('2KB program limit estimate', () => {
  it.each([
    ['x{112}', 'ok'],
    ['x{113}', 'memoryLimitExceeded'],
    ['.{37}', 'ok'],
    ['.{38}', 'memoryLimitExceeded'],
    ['[a-z0-9]{37}', 'ok'],
    ['[a-z0-9]{38}', 'memoryLimitExceeded'],
    ['a{1000}', 'memoryLimitExceeded'],
    // Case-insensitive classes cost the same with or without the upper-case range.
    ['[a-zA-Z0-9]{37}', 'ok'],
    // Assertions are never repeated, and a literal after ^ is not compiled.
    ['\\b{50}x{111}', 'ok'],
    [`^${'x'.repeat(200)}`, 'ok']
  ])('%s → %s', (pattern, expected) => {
    expect(verdict(pattern)).toBe(expected)
  })
})

describe('translated regex semantics', () => {
  it.each<[string, boolean, string, boolean]>([
    ['^https?://[^/]+/ads/', false, 'https://cdn.example.com/ads/x.js', true],
    ['^https?://[^/]+/ads/', false, 'https://cdn.example.com/x/ads/', false],
    ['ADS\\.js', false, 'https://e.com/ads.js', true],
    ['ADS\\.js', true, 'https://e.com/ads.js', false],
    ['(?i)ADS\\.js', true, 'https://e.com/ads.js', true],
    ['(?-i:ADS)\\.js', false, 'https://e.com/ads.js', false],
    // Flags set mid-group carry into later alternatives only.
    ['ab(?i)C|D', true, 'xd', true],
    ['ab(?i)C|D', true, 'aC', false],
    ['\\bads\\b', false, 'https://e.com/my-ads/', true],
    ['\\bads\\b', false, 'https://e.com/myads/', false],
    ['\\Ahttps:', false, 'https://e.com/', true],
    ['\\.com/\\z', false, 'https://e.com/', true],
    ['[[:digit:]]{3}', false, 'https://e.com/a123', true],
    ['[]a]', false, ']', true],
    ['\\Q?q=\\E', false, 'https://e.com/?q=1', true],
    ['a{01}', false, 'a{01}', true],
    ['^(?:a|b)+$', false, 'abba', true],
    ['x{2,3}?y', false, 'xxxy', true],
    ['\\x41\\101', false, 'https://e.com/aa', true],
    ['[a-f0-9]{32}\\.js$', false, `https://e.com/${'aB12'.repeat(8)}.js`, true],
    ['[^a]', false, 'A', false],
    ['(?i:ab)c', true, 'ABc', true],
    ['(?i:ab)c', true, 'ABC', false],
    ['(?:ab){2,3}$', false, 'xABaBab', true],
    ['^a{0}b', false, 'b', true],
    ['\\xc0', false, '\u00e0', true]
  ])('%s (caseSensitive=%s) on %s → %s', (pattern, caseSensitive, url, expected) => {
    expect(compile(pattern, caseSensitive).test(url)).toBe(expected)
  })
})

// V8 reruns a runaway regex on its linear-time engine only when that engine can run it: no case
// folding flag or (?i:...) group, and no repetition replicated past 16.
describe('linear-time engine contract', () => {
  it.each([
    'ADS\\.js',
    '(?i)ab(?-i:C)|D',
    '[[:alpha:]_]+[^x]',
    '^https?://[a-z0-9]{3,8}\\.com/[0-9a-f]{17}',
    '\\b{50}x{3,}?',
    '(a+)+$',
    '(?:(?:ab){4}){5}'
  ])('%s', (pattern) => {
    const { flags, source } = compile(pattern)
    expect(flags).toBe('')
    expect(source).not.toMatch(/\(\?[a-z-]*i/)
    // Counted repetitions without captures are copied out.
    expect(source).not.toContain('{')
  })
})

describe('regexSubstitution', () => {
  it('accepts only \\0-\\9 within the group count and \\\\', () => {
    expect(isValidRegexSubstitution('\\1', 1)).toBe(true)
    expect(isValidRegexSubstitution('\\0\\\\', 0)).toBe(true)
    expect(isValidRegexSubstitution('\\2', 1)).toBe(false)
    expect(isValidRegexSubstitution('\\x', 1)).toBe(false)
    expect(isValidRegexSubstitution('trailing\\', 1)).toBe(false)
  })

  it('counts named groups as captures', () => {
    const result = translateDnrRegex('(?P<a>x)(y)(?:z)', {
      caseSensitive: false,
      requireCapturing: true
    })
    expect(result.ok && result.captureCount).toBe(2)
  })

  // Outputs checked against RE2::Replace.
  it('rewrites only the first match, like RE2::Replace', () => {
    const regex = compile('a(b+)c', false, true)
    expect(applyRegexSubstitution(regex, 'zzabbbczzabczz', 'x\\1y\\0\\\\')).toBe(
      'zzxbbbyabbbc\\zzabczz'
    )
  })

  it('substitutes an empty string for groups that did not participate', () => {
    const regex = compile('(x)?(b+)c', false, true)
    expect(applyRegexSubstitution(regex, 'https://a.example/bbc/x', '[\\2|\\1]')).toBe(
      'https://a.example/[bb|]/x'
    )
  })
})

describe('required literal', () => {
  it.each([
    ['^https?://[a-z]+\\.example\\.com/ads/', '.example.com/ads/'],
    ['(?:foo|bar)baz', 'baz'],
    ['a+bcdef', 'bcdef'],
    ['ab?cdefg', 'cdefg'],
    ['x*', ''],
    ['ABC', 'abc'],
    ['(?:https?://)?(tracker\\.net)/', 'tracker.net']
  ])('%s → %s', (pattern, expected) => {
    const result = translateDnrRegex(pattern, { caseSensitive: true, requireCapturing: false })
    expect(result.ok && result.requiredLiteral).toBe(expected)
  })
})
