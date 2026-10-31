import { describe, expect, it } from 'vitest'
import { matchesExtensionMatchPattern } from './browser-extension-match-pattern'

describe('matchesExtensionMatchPattern', () => {
  it.each([
    ['<all_urls>', 'https://example.com/a', true],
    ['<all_urls>', 'chrome-extension://abc/page.html', false],
    ['*://*/*', 'http://example.com/', true],
    ['*://*/*', 'file:///tmp/a.html', false],
    ['https://*.example.com/*', 'https://example.com/x', true],
    ['https://*.example.com/*', 'https://deep.sub.example.com/x', true],
    ['https://*.example.com/*', 'https://notexample.com/x', false],
    ['https://example.com/app/*', 'https://example.com/app/login?next=1', true],
    ['https://example.com/app/*', 'https://example.com/other', false],
    ['https://example.com/*', 'http://example.com/', false],
    ['not a pattern', 'https://example.com/', false]
  ])('%s vs %s → %s', (pattern, url, expected) => {
    expect(matchesExtensionMatchPattern(pattern, url)).toBe(expected)
  })
})
