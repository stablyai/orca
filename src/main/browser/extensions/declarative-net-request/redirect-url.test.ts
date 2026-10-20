import { describe, expect, it } from 'vitest'
import {
  compareDomains,
  DnrDomainList,
  hostLabelSuffixes,
  hostMatchesDomainLists,
  sameDomainOrHost
} from './domain-matching'
import {
  escapeQueryParamValue,
  parseDnrRedirect,
  transformDnrUrl,
  upgradeDnrUrl
} from './redirect-url'
import { isDnrRuleProblem } from './parse-errors'
import type { DnrUrlTransform } from './rule-types'

function transform(url: string, spec: DnrUrlTransform): string | null {
  const parsed = parseDnrRedirect({ transform: spec }, 1, 'ext')
  if (isDnrRuleProblem(parsed) || parsed.kind !== 'transform') {
    throw new Error('bad transform')
  }
  return transformDnrUrl(url, parsed.transform)
}

describe('transformDnrUrl', () => {
  it.each<[string, DnrUrlTransform, string]>([
    [
      'http://a.com/path?x=1#f',
      { scheme: 'https', host: 'b.com', port: '8443' },
      'https://b.com:8443/path?x=1#f'
    ],
    ['http://a.com:81/path', { port: '' }, 'http://a.com/path'],
    ['http://a.com/path?x=1', { path: '' }, 'http://a.com/?x=1'],
    ['http://a.com/path', { path: 'other' }, 'http://a.com/other'],
    ['http://a.com/p?x=1#f', { query: '', fragment: '' }, 'http://a.com/p'],
    ['http://a.com/p?x=1', { query: '?' }, 'http://a.com/p?'],
    ['http://a.com/p#f', { fragment: '#g' }, 'http://a.com/p#g'],
    ['http://a.com/p', { username: 'u', password: 'p' }, 'http://u:p@a.com/p'],
    ['http://a.com/p', { scheme: 'chrome-extension', host: 'abc' }, 'chrome-extension://abc/p']
  ])('%s with %j → %s', (url, spec, expected) => {
    expect(transform(url, spec)).toBe(expected)
  })

  // GetModifiedQuery: removals and replacements keep the original order; additions go last.
  it.each<[string, DnrUrlTransform['queryTransform'], string]>([
    [
      'http://a.com/?a=1&utm_source=x&b=2',
      { removeParams: ['utm_source'] },
      'http://a.com/?a=1&b=2'
    ],
    ['http://a.com/?utm_source=x', { removeParams: ['utm_source'] }, 'http://a.com/'],
    [
      'http://a.com/?a=1&a=2',
      { addOrReplaceParams: [{ key: 'a', value: 'z' }] },
      'http://a.com/?a=z&a=2'
    ],
    [
      'http://a.com/?a=1',
      { addOrReplaceParams: [{ key: 'b', value: 'c d' }] },
      'http://a.com/?a=1&b=c+d'
    ],
    [
      'http://a.com/?a=1',
      { addOrReplaceParams: [{ key: 'b', value: '1', replaceOnly: true }] },
      'http://a.com/?a=1'
    ],
    // Chromium writes every surviving pair back as key=value.
    ['http://a.com/?flag&x=1', { removeParams: ['x'] }, 'http://a.com/?flag='],
    ['http://a.com/?a=1&&b=2', { removeParams: ['b'] }, 'http://a.com/?a=1&='],
    ['http://a.com/?a=1', { removeParams: ['zzz'] }, 'http://a.com/?a=1']
  ])('%s with %j → %s', (url, queryTransform, expected) => {
    expect(transform(url, { queryTransform })).toBe(expected)
  })

  it('escapes parameter names and values like base::EscapeQueryParamValue', () => {
    expect(escapeQueryParamValue("a b&c=d/é!'()*-._~")).toBe("a+b%26c%3Dd%2F%C3%A9!'()*-._~")
  })
})

describe('upgradeDnrUrl', () => {
  it.each([
    ['http://a.com/x', 'https://a.com/x'],
    ['ftp://a.com:2121/x', 'https://a.com:2121/x'],
    ['https://a.com/x', null],
    ['ws://a.com/x', null]
  ])('%s → %s', (url, expected) => {
    expect(upgradeDnrUrl(url)).toBe(expected)
  })
})

describe('domain lists', () => {
  it('orders domains longest first', () => {
    expect(['a.com', 'google.com', 'zzz.com', 'xy.com'].sort(compareDomains)).toEqual([
      'google.com',
      'zzz.com',
      'xy.com',
      'a.com'
    ])
  })

  const matches = (
    host: string,
    included: string[] | null,
    excluded: string[] | null = null
  ): boolean =>
    hostMatchesDomainLists(
      host,
      hostLabelSuffixes(host),
      included && new DnrDomainList(included),
      excluded && new DnrDomainList(excluded)
    )

  it.each<[string, string[] | null, string[] | null, boolean]>([
    ['a.example.com', ['example.com'], null, true],
    ['example.com.', ['example.com'], null, true],
    ['notexample.com', ['example.com'], null, false],
    ['a.b.example.com', ['example.com'], ['b.example.com'], false],
    ['a.b.example.com', ['a.b.example.com'], ['example.com'], true],
    ['x.com', null, ['x.com'], false],
    ['y.com', null, ['x.com'], true],
    ['', ['x.com'], null, false]
  ])('%s in %j minus %j → %s', (host, included, excluded, expected) => {
    expect(matches(host, included, excluded)).toBe(expected)
  })

  it("keeps Chromium's split between short-list DomainIs and long-list suffix lookup", () => {
    // url::DomainIs accepts a leading-dot entry; the binary search used above five entries does not.
    expect(matches('a.com', ['.com'])).toBe(true)
    expect(matches('a.com', ['.com', 'b.net', 'c.net', 'd.net', 'e.net', 'f.net'])).toBe(false)
  })

  it.each([
    ['www.example.co.uk', 'cdn.example.co.uk', true],
    ['example.co.uk', 'other.co.uk', false],
    ['a.github.io', 'b.github.io', false],
    ['127.0.0.1', '127.0.0.1', true],
    ['10.0.0.1', '10.0.0.2', false],
    ['a.unknowntld', 'b.unknowntld', false]
  ])('sameDomainOrHost(%s, %s) → %s', (left, right, expected) => {
    expect(sameDomainOrHost(left, right)).toBe(expected)
  })
})
