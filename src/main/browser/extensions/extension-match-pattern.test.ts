import { describe, expect, it } from 'vitest'
import {
  extensionCanSeeUrl,
  extensionHasHostPermission,
  globToRegExp,
  matchesUrlPattern
} from './extension-match-pattern'

describe('matchesUrlPattern', () => {
  it.each([
    ['<all_urls>', 'https://example.com/a', true],
    ['<all_urls>', 'chrome-extension://abc/page.html', false],
    ['*://*/*', 'http://localhost:3000/login?next=1', true],
    ['*://*/*', 'file:///tmp/a.html', false],
    ['https://*.example.com/*', 'https://example.com/', true],
    ['https://*.example.com/*', 'https://a.b.example.com/x', true],
    ['https://*.example.com/*', 'https://notexample.com/', false],
    ['https://example.com/app/*', 'https://example.com/app/settings', true],
    ['https://example.com/app/*', 'https://example.com/other', false],
    ['http://localhost/*', 'http://localhost:5173/', true],
    ['file:///*', 'file:///Users/me/index.html', true],
    ['not a pattern', 'https://example.com/', false]
  ])('%s against %s', (pattern, url, expected) => {
    expect(matchesUrlPattern(pattern, url)).toBe(expected)
  })
})

describe('globToRegExp', () => {
  it('treats only * as a wildcard', () => {
    expect(globToRegExp('Sign in*').test('Sign in to GitHub')).toBe(true)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })
})

describe('extensionCanSeeUrl', () => {
  const extension = (manifest: object) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only the manifest.
    ({ manifest }) as Electron.Extension
  it('allows the tabs permission and matching host permissions only', () => {
    expect(extensionCanSeeUrl(extension({ permissions: ['tabs'] }), 'https://a.com/')).toBe(true)
    const scoped = extension({ host_permissions: ['https://a.com/*'] })
    expect(extensionCanSeeUrl(scoped, 'https://a.com/x')).toBe(true)
    expect(extensionCanSeeUrl(scoped, 'https://b.com/x')).toBe(false)
    expect(extensionCanSeeUrl(extension({ permissions: ['storage'] }), 'https://a.com/')).toBe(
      false
    )
  })

  it('does not count tabs as a host permission', () => {
    const url = 'https://a.com/'
    expect(extensionHasHostPermission(extension({ permissions: ['tabs'] }), url)).toBe(false)
    expect(extensionHasHostPermission(extension({ permissions: ['<all_urls>'] }), url)).toBe(true)
  })

  it('ignores the path of a host permission, as Chrome does', () => {
    const scoped = extension({ host_permissions: ['https://a.com/account/*'] })
    expect(extensionHasHostPermission(scoped, 'https://a.com/other')).toBe(true)
    expect(extensionHasHostPermission(scoped, 'http://a.com/other')).toBe(false)
    expect(extensionHasHostPermission(scoped, 'https://b.com/account/x')).toBe(false)
  })
})
