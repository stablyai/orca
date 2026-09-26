import { describe, expect, it } from 'vitest'
import { cancelledShellNavigationTarget } from './cancelled-navigation-target'

describe('cancelledShellNavigationTarget', () => {
  it('opens the three schemes the page may already ask for', () => {
    expect(cancelledShellNavigationTarget('https://example.com/a')).toBe('https://example.com/a')
    expect(cancelledShellNavigationTarget('http://example.com/a')).toBe('http://example.com/a')
    expect(cancelledShellNavigationTarget('mailto:someone@example.com')).toBe(
      'mailto:someone@example.com'
    )
  })

  it('opens the normalized href, not the string the artifact spelled', () => {
    // The WHATWG parser strips tab, LF and CR from anywhere, so this is not the URL it looks like.
    expect(cancelledShellNavigationTarget('ht\ntps://example.com/a')).toBe('https://example.com/a')
    expect(cancelledShellNavigationTarget('https://example.com')).toBe('https://example.com/')
  })

  it('opens nothing for a scheme the grant does not cover', () => {
    expect(cancelledShellNavigationTarget('javascript:alert(1)')).toBeNull()
    expect(cancelledShellNavigationTarget('data:text/html,<b>x')).toBeNull()
    expect(cancelledShellNavigationTarget('file:///etc/passwd')).toBeNull()
    expect(cancelledShellNavigationTarget('orca-mobile-web://sess/')).toBeNull()
  })

  it('opens nothing for a relative target, which is a route rather than a link out', () => {
    expect(cancelledShellNavigationTarget('/h/abc')).toBeNull()
    expect(cancelledShellNavigationTarget('')).toBeNull()
  })

  it('opens nothing for a payload that is not a string', () => {
    expect(cancelledShellNavigationTarget(undefined)).toBeNull()
    expect(cancelledShellNavigationTarget(null)).toBeNull()
    expect(cancelledShellNavigationTarget(42)).toBeNull()
  })
})
