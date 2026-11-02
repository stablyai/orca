import { describe, expect, it } from 'vitest'
import { DnrUrlPatternMatcher, parseUrlFilter, type DnrAnchor } from './url-pattern'
import { canonicalizeDnrUrl, dnrUrlText } from './url-text'

function matches(
  pattern: string,
  left: DnrAnchor,
  right: DnrAnchor,
  url: string,
  matchCase = false
): boolean {
  const spec = canonicalizeDnrUrl(url)
  const text = spec === null ? null : dnrUrlText(spec)
  if (text === null) {
    throw new Error(`bad test url ${url}`)
  }
  const stored = matchCase ? pattern : pattern.toLowerCase()
  return new DnrUrlPatternMatcher({
    pattern: stored,
    anchorLeft: left,
    anchorRight: right,
    matchCase
  }).matches(text)
}

describe('parseUrlFilter', () => {
  it.each([
    ['abc', 'abc', 'none', 'none'],
    ['|abc', 'abc', 'boundary', 'none'],
    ['||abc', 'abc', 'subdomain', 'none'],
    ['abc|', 'abc', 'none', 'boundary'],
    ['||abc|', 'abc', 'subdomain', 'boundary'],
    ['a|b', 'a|b', 'none', 'none'],
    ['|', '', 'boundary', 'none'],
    ['||', '', 'subdomain', 'none'],
    ['|||', '', 'subdomain', 'boundary'],
    ['', '', 'none', 'none']
  ])('%s', (filter, pattern, anchorLeft, anchorRight) => {
    expect(parseUrlFilter(filter)).toEqual({ pattern, anchorLeft, anchorRight })
  })
})

// Vectors from Chromium's components/url_pattern_index/url_pattern_unittest.cc.
describe('DnrUrlPatternMatcher (Chromium vectors)', () => {
  const N = 'none'
  const B = 'boundary'
  const S = 'subdomain'
  it.each<[string, DnrAnchor, DnrAnchor, string, boolean]>([
    ['', N, N, 'http://ex.com/', true],
    ['', B, N, 'http://ex.com/', true],
    ['', S, N, 'http://ex.com/', true],
    ['^', S, N, 'http://ex.com/', false],
    ['.', S, N, 'http://ex.com/', false],
    ['', N, B, 'http://ex.com/', true],
    ['^', N, B, 'http://ex.com/', true],
    ['.', N, B, 'http://ex.com/', false],
    ['', B, B, 'http://ex.com/', false],
    ['', S, B, 'http://ex.com/', false],
    ['com/', S, B, 'http://ex.com/', true],
    ['xampl', N, N, 'http://example.com', true],
    ['example', N, N, 'http://example.com', true],
    ['/a?a', N, N, 'http://ex.com/a?a', true],
    ['^abc', N, N, 'http://ex.com/abc?a', true],
    ['^abc', N, N, 'http://ex.com/a?abc', true],
    ['^abc', N, N, 'http://ex.com/abc?abc', true],
    ['^abc^abc', N, N, 'http://ex.com/abc?abc', true],
    ['^com^abc^abc', N, N, 'http://ex.com/abc?abc', false],
    ['http://ex', B, N, 'http://example.com', true],
    ['http://ex', N, N, 'http://example.com', true],
    ['mple.com/', N, B, 'http://example.com', true],
    ['mple.com/', N, N, 'http://example.com', true],
    ['mple.com/', S, N, 'http://example.com', false],
    ['ex.com', S, N, 'http://hex.com', false],
    ['ex.com', S, N, 'http://ex.com', true],
    ['ex.com', S, N, 'http://hex.ex.com', true],
    ['ex.com', S, N, 'http://hex.hex.com', false],
    ['example.com^', S, N, 'http://www.example.com', true],
    ['http://*mpl', B, N, 'http://example.com', true],
    ['mpl*com/', N, B, 'http://example.com', true],
    ['example^com', N, N, 'http://example.com', false],
    ['example^com', N, N, 'http://example/com', true],
    ['example.com^', N, N, 'http://example.com:8080', true],
    ['http*.com/', B, B, 'http://example.com', true],
    ['http*.org/', B, B, 'http://example.com', false],
    ['/path?*&p1=*&p2=', N, N, 'http://ex.com/aaa/path/bbb?k=v&p1=0&p2=1', false],
    ['/path?*&p1=*&p2=', N, N, 'http://ex.com/aaa/path?k=v&p1=0&p2=1', true],
    ['/path?*&p1=*&p2=', N, N, 'http://ex.com/aaa/path?k=v&k=v&p1=0&p2=1', true],
    ['/path?*&p1=*&p2=', N, N, 'http://ex.com/aaa/path?k=v&p1=0&p3=10&p2=1', true],
    ['/path?*&p1=*&p2=', N, N, 'http://ex.com/aaa/path&p1=0&p2=1', false],
    ['/path?*&p1=*&p2=', N, N, 'http://ex.com/aaa/path?k=v&p2=0&p1=1', false],
    ['abc*def*ghijk*xyz', N, N, 'http://example.com/abcdeffffghijkmmmxyzzz', true],
    ['abc*cdef', N, N, 'http://example.com/abcdef', false],
    ['^^a^^', N, N, 'http://ex.com/?a=/', true],
    ['^^a^^', N, N, 'http://ex.com/?a=/&b=0', true],
    ['^^a^^', N, N, 'http://ex.com/?a=x', false],
    ['^^a^^', N, N, 'http://ex.com/?a=', true],
    ['ex.com^path^*k=v^', N, N, 'http://ex.com/path/?k1=v1&ak=v&kk=vv', true],
    ['ex.com^path^*k=v^', N, N, 'http://ex.com/p/path/?k1=v1&ak=v&kk=vv', false],
    ['a^a&a^a&', N, N, 'http://ex.com/a/a/a/a/?a&a&a&a&a', true],
    ['abc*def^', N, N, 'http://ex.com/abc/a/ddef/', true],
    ['https://example.com/', N, N, 'http://example.com/', false],
    ['example.com/', S, N, 'http://example.com/', true],
    ['examp', S, N, 'http://example.com/', true],
    ['xamp', S, N, 'http://example.com/', false],
    ['examp', S, N, 'http://test.example.com/', true],
    ['t.examp', S, N, 'http://test.example.com/', false],
    ['com^', S, N, 'http://test.example.com/', true],
    ['com^x', S, B, 'http://a.com/x', true],
    ['x.com', S, N, 'http://ex.com/?url=x.com', false],
    ['ex.com/', S, B, 'http://ex.com/', true],
    ['ex.com^', S, B, 'http://ex.com/', true],
    ['ex.co', S, B, 'http://ex.com/', false],
    ['ex.com', S, B, 'http://rex.com.ex.com/', false],
    ['ex.com/', S, B, 'http://rex.com.ex.com/', true],
    ['http', S, B, 'http://http.com/', false],
    ['http', S, N, 'http://http.com/', true],
    ['/example.com', S, B, 'http://example.com/', false],
    ['/example.com/', S, B, 'http://example.com/', false],
    ['.', S, N, 'http://a..com/', true],
    ['^', S, N, 'http://a..com/', false],
    ['.', S, N, 'http://a.com./', false],
    ['^', S, N, 'http://a.com./', true],
    ['.', S, N, 'http://a.com../', true],
    ['^', S, N, 'http://a.com../', true],
    ['/path', S, N, 'http://a.com./path/to/x', true],
    ['^path', S, N, 'http://a.com./path/to/x', true],
    ['/path', S, B, 'http://a.com./path', true],
    ['^path', S, B, 'http://a.com./path', true],
    ['path', S, B, 'http://a.com./path', false],
    ['abc^', N, N, 'https://xyz.com/abc/123', true],
    ['abc^', N, N, 'https://xyz.com/abc', true],
    ['abc^', N, N, 'https://abc.com', false],
    ['abc^', N, B, 'https://xyz.com/abc/', true],
    ['abc^', N, B, 'https://xyz.com/abc', true],
    ['abc^', N, B, 'https://xyz.com/abc/123', false],
    ['http://abc.com/x^', B, N, 'http://abc.com/x', true],
    ['http://abc.com/x^', B, N, 'http://abc.com/x/', true],
    ['http://abc.com/x^', B, N, 'http://abc.com/x/123', true],
    ['http://abc.com/x^', B, B, 'http://abc.com/x', true],
    ['http://abc.com/x^', B, B, 'http://abc.com/x/', true],
    ['http://abc.com/x^', B, B, 'http://abc.com/x/123', false],
    ['abc.com^', S, N, 'http://xyz.abc.com/123', true],
    ['abc.com^', S, N, 'http://xyz.abc.com', true],
    ['abc.com^', S, N, 'http://abc.com.xyz.com?q=abc.com', false],
    ['abc.com^', S, B, 'http://xyz.abc.com/123', false],
    ['abc.com^', S, B, 'http://xyz.abc.com', true],
    ['abc.com^', S, B, 'http://abc.com.xyz.com?q=abc.com/', false],
    ['abc*^', N, N, 'https://abc.com', true],
    ['abc*^', N, N, 'https://abc.com?q=123', true],
    ['abc*^', N, B, 'https://abc.com', true],
    ['abc*^', N, B, 'https://abc.com?q=123', true],
    ['abc*', N, B, 'https://a.com/abcxyz', true],
    ['*google.com', B, N, 'https://www.google.com', true],
    ['*', B, B, 'https://example.com', true],
    ['', B, B, 'https://example.com', false]
  ])('%s (%s,%s) vs %s → %s', (pattern, left, right, url, expected) => {
    expect(matches(pattern, left, right, url)).toBe(expected)
  })

  it.each<[string, string, boolean, boolean]>([
    ['path', 'http://a.com/PaTh', false, true],
    ['path', 'http://a.com/PaTh', true, false],
    ['path', 'http://a.com/path', true, true],
    ['abc*def^', 'http://a.com/abcxAdef/vo', true, true],
    ['abc*def^', 'http://a.com/aBcxAdeF/vo', true, false],
    ['abc*def^', 'http://a.com/aBcxAdeF/vo', false, true]
  ])('case: %s vs %s matchCase=%s → %s', (pattern, url, matchCase, expected) => {
    expect(matches(pattern, 'none', 'none', url, matchCase)).toBe(expected)
  })
})
